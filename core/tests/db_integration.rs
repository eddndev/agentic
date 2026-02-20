//! Integration tests for sqlx column mapping against real Postgres.
//! Verifies that FromRow deserialization works with Prisma's camelCase columns.
//!
//! Run with: cargo test --test db_integration

use anyhow::Result;
use sqlx::postgres::PgPoolOptions;

use agentic_core::models::db::{Execution, Flow, Session, Step, Trigger};

async fn get_pool() -> sqlx::PgPool {
    dotenvy::dotenv().ok();
    let db_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .expect("Failed to connect to Postgres")
}

#[tokio::test]
async fn test_trigger_deserialization() -> Result<()> {
    let pool = get_pool().await;

    let triggers = sqlx::query_as::<_, Trigger>(
        r#"
        SELECT
            t.id, t."botId", t."sessionId", t.keyword, t."matchType",
            t."isActive", t."flowId", t."createdAt", t."updatedAt", t.scope,
            f."cooldownMs", f."usageLimit", f."excludesFlows"
        FROM "Trigger" t
        JOIN "Flow" f ON t."flowId" = f.id
        LIMIT 5
        "#,
    )
    .fetch_all(&pool)
    .await?;

    println!("Fetched {} triggers", triggers.len());
    for t in &triggers {
        println!(
            "  Trigger: id={}, keyword='{}', matchType={:?}, scope={:?}, flowId={}, isActive={}",
            t.id, t.keyword, t.match_type, t.scope, t.flow_id, t.is_active
        );
    }

    assert!(!triggers.is_empty(), "Expected at least one trigger in DB");

    let t = &triggers[0];
    assert!(!t.id.is_empty());
    assert!(!t.keyword.is_empty());
    assert!(!t.flow_id.is_empty());

    Ok(())
}

#[tokio::test]
async fn test_flow_deserialization() -> Result<()> {
    let pool = get_pool().await;

    let flows = sqlx::query_as::<_, Flow>(r#"SELECT * FROM "Flow" LIMIT 5"#)
        .fetch_all(&pool)
        .await?;

    println!("Fetched {} flows", flows.len());
    for f in &flows {
        println!(
            "  Flow: id={}, name='{}', cooldownMs={}, usageLimit={}, excludesFlows={:?}",
            f.id, f.name, f.cooldown_ms, f.usage_limit, f.excludes_flows
        );
    }

    assert!(!flows.is_empty(), "Expected at least one flow in DB");

    let f = &flows[0];
    assert!(!f.id.is_empty());
    assert!(!f.name.is_empty());
    assert!(!f.bot_id.is_empty());

    Ok(())
}

#[tokio::test]
async fn test_step_deserialization() -> Result<()> {
    let pool = get_pool().await;

    let steps = sqlx::query_as::<_, Step>(r#"SELECT * FROM "Step" LIMIT 5"#)
        .fetch_all(&pool)
        .await?;

    println!("Fetched {} steps", steps.len());
    for s in &steps {
        println!(
            "  Step: id={}, flowId={}, type={:?}, order={}, delayMs={}, jitterPct={}",
            s.id, s.flow_id, s.r#type, s.order, s.delay_ms, s.jitter_pct
        );
    }

    assert!(!steps.is_empty(), "Expected at least one step in DB");

    let s = &steps[0];
    assert!(!s.id.is_empty());
    assert!(!s.flow_id.is_empty());

    Ok(())
}

#[tokio::test]
async fn test_execution_deserialization() -> Result<()> {
    let pool = get_pool().await;

    let executions = sqlx::query_as::<_, Execution>(r#"SELECT * FROM "Execution" LIMIT 5"#)
        .fetch_all(&pool)
        .await?;

    println!("Fetched {} executions", executions.len());
    for e in &executions {
        println!(
            "  Execution: id={}, flowId={}, sessionId={}, status={}, currentStep={}, trigger={:?}",
            e.id, e.flow_id, e.session_id, e.status, e.current_step, e.trigger
        );
    }

    assert!(
        !executions.is_empty(),
        "Expected at least one execution in DB"
    );

    let e = &executions[0];
    assert!(!e.id.is_empty());
    assert!(!e.flow_id.is_empty());
    assert!(!e.session_id.is_empty());

    Ok(())
}

#[tokio::test]
async fn test_session_deserialization() -> Result<()> {
    let pool = get_pool().await;

    let sessions = sqlx::query_as::<_, Session>(r#"SELECT * FROM "Session" LIMIT 5"#)
        .fetch_all(&pool)
        .await?;

    println!("Fetched {} sessions", sessions.len());
    for s in &sessions {
        println!(
            "  Session: id={}, platform={:?}, identifier={}, botId={}, status={:?}",
            s.id, s.platform, s.identifier, s.bot_id, s.status
        );
    }

    assert!(!sessions.is_empty(), "Expected at least one session in DB");

    let s = &sessions[0];
    assert!(!s.id.is_empty());
    assert!(!s.bot_id.is_empty());

    Ok(())
}
