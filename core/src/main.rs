pub mod flow_engine;
pub mod matcher;
pub mod models;
pub mod processors;

use std::sync::Arc;

use anyhow::{Context, Result};
use redis::aio::MultiplexedConnection;
use redis::streams::{StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::env;
use tracing::{error, info};

pub struct AppState {
    pub pool: PgPool,
    pub redis: MultiplexedConnection,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env if it exists
    dotenvy::dotenv().ok();

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    info!("Starting Agentic Core Engine (Rust)...");

    let redis_url =
        env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    // Initialize Postgres Pool
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&db_url)
        .await
        .context("Failed to connect to Postgres")?;
    info!("Connected to Postgres.");

    // Initialize Redis Connection
    let redis_client = redis::Client::open(redis_url)?;
    let redis_conn = redis_client.get_multiplexed_async_connection().await?;
    info!("Connected to Redis.");

    let state = Arc::new(AppState {
        pool,
        redis: redis_conn,
    });

    let stream_key = "agentic:queue:incoming";
    let group_name = "agentic_core_group";
    let consumer_name = "core_worker_1";

    // Attempt to create the consumer group, ignore if it already exists
    let _ = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(stream_key)
        .arg(group_name)
        .arg("$")
        .arg("MKSTREAM")
        .query_async::<()>(&mut state.redis.clone())
        .await;

    // Startup recovery: re-schedule any RUNNING executions
    flow_engine::recover_running_executions(state.clone()).await;

    info!(
        stream = stream_key,
        "Listening for incoming messages on Redis stream"
    );

    loop {
        // Read from stream using consumer group
        let opts = StreamReadOptions::default()
            .group(group_name, consumer_name)
            .block(5000)
            .count(10);

        let result: redis::RedisResult<StreamReadReply> = state
            .redis
            .clone()
            .xread_options(&[stream_key], &[">"], &opts)
            .await;

        match result {
            Ok(reply) => {
                for stream in reply.keys {
                    let key = stream.key;
                    for message in stream.ids {
                        let id = message.id.clone();
                        let map = &message.map;

                        if let Some(val) = map.get("payload") {
                            if let Ok(payload_str) =
                                redis::from_redis_value::<String>(val)
                            {
                                // Parse JSON payload into IncomingMessage
                                match serde_json::from_str::<
                                    models::payloads::IncomingMessage,
                                >(
                                    &payload_str
                                ) {
                                    Ok(payload) => {
                                        match payload {
                                            models::payloads::IncomingMessage::NewMessage {
                                                bot_id,
                                                session_id,
                                                identifier,
                                                platform: _,
                                                from_me,
                                                sender,
                                                message: msg_content,
                                            } => {
                                                let content = msg_content
                                                    .text
                                                    .clone()
                                                    .unwrap_or_default();
                                                info!(
                                                    bot_id = bot_id,
                                                    session_id = session_id,
                                                    from_me = from_me,
                                                    content_preview = &content[..content.len().min(50)],
                                                    "Received NEW_MESSAGE"
                                                );

                                                let spawn_state = state.clone();
                                                tokio::spawn(async move {
                                                    if let Err(e) =
                                                        flow_engine::process_incoming_message(
                                                            spawn_state,
                                                            &bot_id,
                                                            &session_id,
                                                            &identifier,
                                                            from_me,
                                                            &sender,
                                                            &content,
                                                        )
                                                        .await
                                                    {
                                                        error!(
                                                            error = %e,
                                                            "Failed to process incoming message"
                                                        );
                                                    }
                                                });
                                            }
                                            models::payloads::IncomingMessage::ExecuteStep {
                                                execution_id,
                                                step_id,
                                            } => {
                                                info!(
                                                    execution_id = execution_id,
                                                    step_id = step_id,
                                                    "Received EXECUTE_STEP"
                                                );

                                                let spawn_state = state.clone();
                                                tokio::spawn(async move {
                                                    if let Err(e) =
                                                        processors::execute_step(
                                                            &spawn_state,
                                                            &execution_id,
                                                            &step_id,
                                                            -1, // Legacy: no step_order from external dispatch
                                                        )
                                                        .await
                                                    {
                                                        error!(
                                                            error = %e,
                                                            execution_id = execution_id,
                                                            "Failed to execute step"
                                                        );
                                                    }
                                                });
                                            }
                                        }

                                        // Acknowledge message
                                        let _: redis::RedisResult<()> = state
                                            .redis
                                            .clone()
                                            .xack(&key, group_name, &[&id])
                                            .await;
                                    }
                                    Err(e) => {
                                        error!(
                                            payload = payload_str,
                                            error = %e,
                                            "Failed to parse payload"
                                        );
                                        // ACK to avoid poison pill
                                        let _: redis::RedisResult<()> = state
                                            .redis
                                            .clone()
                                            .xack(&key, group_name, &[&id])
                                            .await;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                error!(error = %e, "Error reading from Redis Stream");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}
