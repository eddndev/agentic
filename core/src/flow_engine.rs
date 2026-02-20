use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::Utc;
use rand::Rng;
use redis::AsyncCommands;
use sqlx::Row;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::matcher;
use crate::models::db::{Execution, Step, Trigger};
use crate::AppState;

type BoxFut = Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// Replicates FlowEngine.processIncomingMessage() from Node.js.
/// Matches triggers, validates constraints, creates execution, and schedules step 0.
pub async fn process_incoming_message(
    state: Arc<AppState>,
    bot_id: &str,
    session_id: &str,
    _identifier: &str,
    from_me: bool,
    sender: &str,
    content: &str,
) -> Result<()> {
    // Early return if empty
    if content.trim().is_empty() {
        return Ok(());
    }

    // Determine valid scopes based on direction
    let valid_scopes: Vec<&str> = if from_me {
        vec!["OUTGOING", "BOTH"]
    } else {
        vec!["INCOMING", "BOTH"]
    };

    // Query active triggers with joined flow fields
    let triggers = sqlx::query_as::<_, Trigger>(
        r#"
        SELECT
            t.id, t."botId", t."sessionId", t.keyword, t."matchType",
            t."isActive", t."flowId", t."createdAt", t."updatedAt", t.scope,
            f."cooldownMs", f."usageLimit", f."excludesFlows"
        FROM "Trigger" t
        JOIN "Flow" f ON t."flowId" = f.id
        WHERE t."isActive" = true
          AND t.scope = ANY($1)
          AND (
            t."sessionId" = $2
            OR (t."botId" = $3 AND t."sessionId" IS NULL)
          )
        "#,
    )
    .bind(&valid_scopes)
    .bind(session_id)
    .bind(bot_id)
    .fetch_all(&state.pool)
    .await
    .context("Failed to fetch active triggers")?;

    if triggers.is_empty() {
        return Ok(());
    }

    // Match against triggers
    let match_result = match matcher::find_match(content, &triggers) {
        Some(m) => m,
        None => return Ok(()),
    };

    let trigger = match_result.trigger;
    let lock_key = format!("flow:lock:{}:{}", session_id, trigger.flow_id);

    // Acquire distributed lock (SET NX EX 30)
    let lock_acquired: bool = redis::cmd("SET")
        .arg(&lock_key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(30)
        .query_async(&mut state.redis.clone())
        .await
        .unwrap_or(false);

    if !lock_acquired {
        info!(
            trigger = trigger.keyword,
            "Trigger ignored: lock already held (concurrent execution in progress)"
        );
        return Ok(());
    }

    // Ensure lock is always released
    let cleanup_state = state.clone();
    let cleanup_key = lock_key.clone();

    let result = async {
        // Validate constraints and create execution in a transaction
        let mut tx = state.pool.begin().await.context("Failed to begin transaction")?;

        let cooldown_ms = trigger.cooldown_ms.unwrap_or(0);
        let usage_limit = trigger.usage_limit.unwrap_or(0);
        let excludes_flows = trigger.excludes_flows.clone().unwrap_or_default();

        // Cooldown check
        if cooldown_ms > 0 {
            let last_execution = sqlx::query(
                r#"SELECT "startedAt" FROM "Execution" WHERE "sessionId" = $1 AND "flowId" = $2 ORDER BY "startedAt" DESC LIMIT 1"#,
            )
            .bind(session_id)
            .bind(&trigger.flow_id)
            .fetch_optional(&mut *tx)
            .await?;

            if let Some(row) = last_execution {
                let started_at: chrono::DateTime<Utc> = row.get("startedAt");
                let elapsed = Utc::now()
                    .signed_duration_since(started_at)
                    .num_milliseconds();
                if elapsed < cooldown_ms as i64 {
                    let msg = format!("Cooldown active ({}/{}ms)", elapsed, cooldown_ms);
                    info!(trigger = trigger.keyword, "{}", msg);
                    tx.rollback().await.ok();
                    create_failed_execution(
                        &state.pool, session_id, &trigger.flow_id, sender, &trigger.keyword, &msg,
                    )
                    .await;
                    return Ok(());
                }
            }
        }

        // Usage limit check
        if usage_limit > 0 {
            let count: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*) FROM "Execution" WHERE "sessionId" = $1 AND "flowId" = $2"#,
            )
            .bind(session_id)
            .bind(&trigger.flow_id)
            .fetch_one(&mut *tx)
            .await?;

            if count >= usage_limit as i64 {
                let msg = format!("Usage limit reached ({}/{})", count, usage_limit);
                info!(trigger = trigger.keyword, "{}", msg);
                tx.rollback().await.ok();
                create_failed_execution(
                    &state.pool, session_id, &trigger.flow_id, sender, &trigger.keyword, &msg,
                )
                .await;
                return Ok(());
            }
        }

        // Exclusion check
        if !excludes_flows.is_empty() {
            let conflict_count: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*) FROM "Execution" WHERE "sessionId" = $1 AND "flowId" = ANY($2)"#,
            )
            .bind(session_id)
            .bind(&excludes_flows)
            .fetch_one(&mut *tx)
            .await?;

            if conflict_count > 0 {
                let msg = "Mutually exclusive flow already executed".to_string();
                info!(trigger = trigger.keyword, "{}", msg);
                tx.rollback().await.ok();
                create_failed_execution(
                    &state.pool, session_id, &trigger.flow_id, sender, &trigger.keyword, &msg,
                )
                .await;
                return Ok(());
            }
        }

        // All validations passed — create execution
        let execution_id = Uuid::new_v4().to_string();
        info!(
            trigger = trigger.keyword,
            flow_id = trigger.flow_id,
            execution_id = execution_id,
            "Matched trigger -> creating execution"
        );

        sqlx::query(
            r#"
            INSERT INTO "Execution" (id, "sessionId", "flowId", "platformUserId", status, "currentStep", "variableContext", "startedAt", "updatedAt", trigger)
            VALUES ($1, $2, $3, $4, 'RUNNING', 0, '{}', NOW(), NOW(), $5)
            "#,
        )
        .bind(&execution_id)
        .bind(session_id)
        .bind(&trigger.flow_id)
        .bind(sender)
        .bind(&trigger.keyword)
        .execute(&mut *tx)
        .await
        .context("Failed to create execution")?;

        tx.commit().await.context("Failed to commit transaction")?;

        // Schedule the first step (outside transaction)
        schedule_step(state.clone(), execution_id, 0).await;

        Ok::<(), anyhow::Error>(())
    }
    .await;

    // Always release lock
    let _: redis::RedisResult<()> = cleanup_state
        .redis
        .clone()
        .del(&cleanup_key)
        .await;

    result
}

/// Replicates FlowEngine.scheduleStep() from Node.js.
/// Fetches execution and flow steps, calculates delay with jitter, then spawns delayed execution.
/// Returns BoxFut to break recursive async type cycle with execute_and_advance.
pub fn schedule_step(state: Arc<AppState>, execution_id: String, step_order: i32) -> BoxFut {
    Box::pin(async move {
        // Fetch execution
        let execution = match sqlx::query_as::<_, Execution>(
            r#"SELECT * FROM "Execution" WHERE id = $1"#,
        )
        .bind(&execution_id)
        .fetch_optional(&state.pool)
        .await
        {
            Ok(Some(e)) => e,
            Ok(None) => {
                warn!(execution_id = execution_id, "Execution not found for scheduling");
                return;
            }
            Err(e) => {
                error!(execution_id = execution_id, error = %e, "Failed to fetch execution");
                return;
            }
        };

        if execution.status != "RUNNING" {
            info!(
                execution_id = execution_id,
                status = execution.status,
                "Execution not RUNNING, skipping schedule"
            );
            return;
        }

        // Fetch steps for this flow
        let steps = match sqlx::query_as::<_, Step>(
            r#"SELECT * FROM "Step" WHERE "flowId" = $1 ORDER BY "order" ASC"#,
        )
        .bind(&execution.flow_id)
        .fetch_all(&state.pool)
        .await
        {
            Ok(s) => s,
            Err(e) => {
                error!(
                    execution_id = execution_id,
                    error = %e,
                    "Failed to fetch steps"
                );
                return;
            }
        };

        // Find step by order
        let step = match steps.iter().find(|s| s.order == step_order) {
            Some(s) => s.clone(),
            None => {
                // No more steps — mark execution as COMPLETED
                info!(
                    execution_id = execution_id,
                    flow_id = execution.flow_id,
                    "Flow finished"
                );
                let _ = sqlx::query(
                    r#"UPDATE "Execution" SET status = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1"#,
                )
                .bind(&execution_id)
                .execute(&state.pool)
                .await;
                return;
            }
        };

        // Calculate delay with jitter
        let base = step.delay_ms as i64;
        let variance = (base * step.jitter_pct as i64) / 100;
        let jitter = if variance > 0 {
            rand::thread_rng().gen_range(-variance..=variance)
        } else {
            0
        };
        let final_delay = std::cmp::max(0, base + jitter) as u64;

        info!(
            execution_id = execution_id,
            step_order = step_order,
            delay_ms = final_delay,
            "Scheduling step"
        );

        // Spawn delayed execution with all owned values
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(final_delay)).await;
            execute_and_advance(state, execution_id, step).await;
        });
    })
}

/// Executes a step and advances to the next one.
/// Combines StepProcessor + completeStep logic.
/// Returns BoxFut to break recursive async type cycle with schedule_step.
fn execute_and_advance(state: Arc<AppState>, execution_id: String, step: Step) -> BoxFut {
    Box::pin(async move {
        // Update current step
        let _ = sqlx::query(
            r#"UPDATE "Execution" SET "currentStep" = $1, "updatedAt" = NOW() WHERE id = $2"#,
        )
        .bind(step.order)
        .bind(&execution_id)
        .execute(&state.pool)
        .await;

        // Execute the step
        if let Err(e) =
            crate::processors::execute_step(&state, &execution_id, &step.id, step.order).await
        {
            error!(
                execution_id = execution_id,
                step_id = step.id,
                step_order = step.order,
                error = %e,
                "Step execution failed, continuing to next step"
            );
            // Record error on execution but continue
            let _ = sqlx::query(
                r#"UPDATE "Execution" SET error = $1, "updatedAt" = NOW() WHERE id = $2"#,
            )
            .bind(format!("Step {} error: {}", step.order, e))
            .bind(&execution_id)
            .execute(&state.pool)
            .await;
        }

        // Always advance to next step
        schedule_step(state, execution_id, step.order + 1).await;
    })
}

/// Creates a FAILED execution record for validation failures (cooldown, limit, exclusion).
async fn create_failed_execution(
    pool: &sqlx::PgPool,
    session_id: &str,
    flow_id: &str,
    sender: &str,
    trigger_keyword: &str,
    error_msg: &str,
) {
    let id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        r#"
        INSERT INTO "Execution" (id, "sessionId", "flowId", "platformUserId", status, "currentStep", "variableContext", "startedAt", "updatedAt", "completedAt", error, trigger)
        VALUES ($1, $2, $3, $4, 'FAILED', 0, '{}', NOW(), NOW(), NOW(), $5, $6)
        "#,
    )
    .bind(&id)
    .bind(session_id)
    .bind(flow_id)
    .bind(sender)
    .bind(error_msg)
    .bind(trigger_keyword)
    .execute(pool)
    .await;

    if let Err(e) = result {
        error!(error = %e, "Failed to create FAILED execution record");
    }
}

/// Startup recovery: re-schedule RUNNING executions that were interrupted.
pub async fn recover_running_executions(state: Arc<AppState>) {
    info!("Checking for RUNNING executions to recover...");

    let executions = match sqlx::query_as::<_, Execution>(
        r#"SELECT * FROM "Execution" WHERE status = 'RUNNING'"#,
    )
    .fetch_all(&state.pool)
    .await
    {
        Ok(e) => e,
        Err(e) => {
            error!(error = %e, "Failed to query RUNNING executions for recovery");
            return;
        }
    };

    if executions.is_empty() {
        info!("No RUNNING executions to recover");
        return;
    }

    info!(count = executions.len(), "Recovering RUNNING executions");

    for exec in executions {
        let next_step = exec.current_step;
        info!(
            execution_id = exec.id,
            current_step = next_step,
            "Re-scheduling execution"
        );
        schedule_step(state.clone(), exec.id.clone(), next_step).await;
    }
}
