//! E2E Round Trip Test
//!
//! Publishes a NEW_MESSAGE to agentic:queue:incoming that should match
//! the existing trigger, then verifies the Rust core produces an outgoing
//! message on agentic:queue:outgoing.
//!
//! Prerequisites:
//! - Postgres with real data (trigger keyword "Le mando la información", scope OUTGOING)
//! - Redis running
//!
//! Run with: cargo test --test e2e_roundtrip -- --nocapture

use anyhow::Result;
use redis::AsyncCommands;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;

use agentic_core::{flow_engine, AppState};

async fn setup() -> Result<(Arc<AppState>, redis::aio::MultiplexedConnection)> {
    dotenvy::dotenv().ok();

    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    let redis_client = redis::Client::open(redis_url)?;
    let redis_conn = redis_client.get_multiplexed_async_connection().await?;

    let state = Arc::new(AppState {
        pool,
        redis: redis_conn.clone(),
    });

    Ok((state, redis_conn))
}

#[tokio::test]
async fn test_outgoing_trigger_roundtrip() -> Result<()> {
    let (state, mut redis_conn) = setup().await?;

    // Find an existing trigger+session+bot to use for the test
    let trigger = sqlx::query_as::<_, agentic_core::models::db::Trigger>(
        r#"
        SELECT
            t.id, t."botId", t."sessionId", t.keyword, t."matchType",
            t."isActive", t."flowId", t."createdAt", t."updatedAt", t.scope,
            f."cooldownMs", f."usageLimit", f."excludesFlows"
        FROM "Trigger" t
        JOIN "Flow" f ON t."flowId" = f.id
        WHERE t."isActive" = true
        LIMIT 1
        "#,
    )
    .fetch_optional(&state.pool)
    .await?;

    let trigger = match trigger {
        Some(t) => t,
        None => {
            println!("SKIP: No active triggers in DB");
            return Ok(());
        }
    };

    println!(
        "Using trigger: keyword='{}', matchType={:?}, scope={:?}, flowId={}",
        trigger.keyword, trigger.match_type, trigger.scope, trigger.flow_id
    );

    // Find a session for this bot
    let session = sqlx::query_as::<_, agentic_core::models::db::Session>(
        r#"SELECT * FROM "Session" WHERE "botId" = $1 LIMIT 1"#,
    )
    .bind(&trigger.bot_id)
    .fetch_optional(&state.pool)
    .await?;

    let session = match session {
        Some(s) => s,
        None => {
            println!("SKIP: No sessions for bot {}", trigger.bot_id);
            return Ok(());
        }
    };

    println!(
        "Using session: id={}, identifier={}",
        session.id, session.identifier
    );

    // Determine from_me based on trigger scope
    let from_me = match trigger.scope {
        agentic_core::models::db::TriggerScope::OUTGOING => true,
        agentic_core::models::db::TriggerScope::BOTH => true,
        agentic_core::models::db::TriggerScope::INCOMING => false,
    };

    // Create outgoing consumer group for reading results
    let outgoing_stream = "agentic:queue:outgoing";
    let test_group = "test_e2e_group";
    let _ = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(outgoing_stream)
        .arg(test_group)
        .arg("$")
        .arg("MKSTREAM")
        .query_async::<()>(&mut redis_conn)
        .await;

    // Run the flow engine directly (bypass stream — test the core logic)
    println!("Calling process_incoming_message...");
    flow_engine::process_incoming_message(
        state.clone(),
        &trigger.bot_id,
        &session.id,
        &session.identifier,
        from_me,
        &session.identifier,
        &trigger.keyword,
    )
    .await?;

    // Wait for async step processing (delay + execution)
    println!("Waiting for step processing (3s)...");
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Read from outgoing stream
    let result: redis::RedisResult<Vec<(String, Vec<(String, Vec<(String, String)>)>)>> =
        redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(test_group)
            .arg("test_consumer")
            .arg("COUNT")
            .arg("10")
            .arg("BLOCK")
            .arg("2000")
            .arg("STREAMS")
            .arg(outgoing_stream)
            .arg(">")
            .query_async(&mut redis_conn)
            .await;

    match result {
        Ok(streams) => {
            let mut total_messages = 0;
            for (_stream_key, messages) in &streams {
                for (msg_id, fields) in messages {
                    total_messages += 1;
                    for (key, value) in fields {
                        if key == "payload" {
                            let parsed: serde_json::Value = serde_json::from_str(value)?;
                            println!(
                                "  OUTGOING [{}]: bot_id={}, target={}, execution_id={}, payload_keys={:?}",
                                msg_id,
                                parsed["bot_id"],
                                parsed["target"],
                                parsed["execution_id"],
                                parsed["payload"].as_object().map(|o| o.keys().collect::<Vec<_>>())
                            );

                            // Verify the message is for our bot and target
                            assert_eq!(
                                parsed["bot_id"].as_str().unwrap(),
                                session.bot_id,
                                "bot_id should match"
                            );
                            assert_eq!(
                                parsed["target"].as_str().unwrap(),
                                session.identifier,
                                "target should match session identifier"
                            );
                            assert!(
                                parsed["execution_id"].as_str().is_some(),
                                "execution_id should be present"
                            );
                        }
                    }

                    // ACK the test message
                    let _: redis::RedisResult<()> = redis_conn
                        .xack(outgoing_stream, test_group, &[msg_id.as_str()])
                        .await;
                }
            }
            println!("Total outgoing messages received: {}", total_messages);
            assert!(
                total_messages > 0,
                "Expected at least one outgoing message"
            );
        }
        Err(e) => {
            panic!("Failed to read from outgoing stream: {}", e);
        }
    }

    // Cleanup: delete test consumer group
    let _: redis::RedisResult<()> = redis::cmd("XGROUP")
        .arg("DESTROY")
        .arg(outgoing_stream)
        .arg(test_group)
        .query_async(&mut redis_conn)
        .await;

    println!("E2E round trip test PASSED");
    Ok(())
}
