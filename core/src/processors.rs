use std::sync::Arc;

use crate::models::db::{Execution, Session, Step};
use anyhow::{Context, Result};
use chrono::Timelike;
use chrono_tz::America::Mexico_City;
use tracing::{error, info, warn};

use crate::AppState;

pub async fn execute_step(
    state: &Arc<AppState>,
    execution_id: &str,
    step_id: &str,
    step_order: i32,
) -> Result<()> {
    info!(
        step_id = step_id,
        execution_id = execution_id,
        "[StepProcessor] Processing step"
    );

    // 1. Fetch Step Data
    let step = sqlx::query_as::<_, Step>(r#"SELECT * FROM "Step" WHERE id = $1"#)
        .bind(step_id)
        .fetch_optional(&state.pool)
        .await
        .context("Failed to query Step")?;

    let step = match step {
        Some(s) => s,
        None => {
            warn!(step_id = step_id, "Step not found, skipping");
            return Ok(());
        }
    };

    // 2. Fetch Execution Data
    let execution =
        sqlx::query_as::<_, Execution>(r#"SELECT * FROM "Execution" WHERE id = $1"#)
            .bind(execution_id)
            .fetch_optional(&state.pool)
            .await
            .context("Failed to query Execution")?;

    let execution = match execution {
        Some(e) => e,
        None => {
            warn!(execution_id = execution_id, "Execution not found");
            return Ok(());
        }
    };

    // 3. Fetch Session Data
    let session =
        sqlx::query_as::<_, Session>(r#"SELECT * FROM "Session" WHERE id = $1"#)
            .bind(&execution.session_id)
            .fetch_optional(&state.pool)
            .await
            .context("Failed to query Session")?;

    let session = match session {
        Some(s) => s,
        None => {
            warn!(
                session_id = execution.session_id,
                execution_id = execution_id,
                "Session not found for execution"
            );
            return Ok(());
        }
    };

    info!(
        step_type = step.r#type.as_str(),
        identifier = session.identifier,
        platform = session.platform.as_str(),
        "Executing step"
    );

    use crate::models::conditionals::{
        ConditionalTimeMetadata, MediaPayload, OutgoingMessage, OutgoingPayload,
    };

    use crate::models::db::{Platform, StepType};

    if session.platform == Platform::WHATSAPP {
        let mut outgoing_payload = OutgoingPayload {
            text: None,
            image: None,
            audio: None,
            caption: None,
            ptt: None,
        };

        match step.r#type {
            StepType::TEXT => {
                outgoing_payload.text = step.content.clone();
            }
            StepType::IMAGE => {
                if let Some(media_url) = &step.media_url {
                    outgoing_payload.image = Some(MediaPayload {
                        url: media_url.clone(),
                    });
                    outgoing_payload.caption = step.content.clone();
                } else {
                    error!(step_id = step.id, "IMAGE step has no mediaUrl, skipping");
                }
            }
            StepType::AUDIO | StepType::PTT => {
                if let Some(media_url) = &step.media_url {
                    outgoing_payload.audio = Some(MediaPayload {
                        url: media_url.clone(),
                    });
                    outgoing_payload.ptt = Some(step.r#type == StepType::PTT);
                } else {
                    error!(
                        step_type = step.r#type.as_str(),
                        step_id = step.id,
                        "Step has no mediaUrl, skipping"
                    );
                }
            }
            StepType::CONDITIONAL_TIME => {
                if let Some(meta_val) = &step.metadata {
                    if let Ok(metadata) =
                        serde_json::from_value::<ConditionalTimeMetadata>(meta_val.clone())
                    {
                        let now = chrono::Utc::now().with_timezone(&Mexico_City);
                        let current_minutes = now.hour() * 60 + now.minute();

                        info!(
                            current_minutes = current_minutes,
                            "Conditional time check"
                        );

                        let to_minutes = |time_str: &str| -> Option<u32> {
                            let parts: Vec<&str> = time_str.split(':').collect();
                            if parts.len() == 2 {
                                if let (Ok(h), Ok(m)) =
                                    (parts[0].parse::<u32>(), parts[1].parse::<u32>())
                                {
                                    return Some(h * 60 + m);
                                }
                            }
                            None
                        };

                        let mut match_found = false;

                        for branch in &metadata.branches {
                            if let (Some(start), Some(end)) =
                                (to_minutes(&branch.start_time), to_minutes(&branch.end_time))
                            {
                                let is_match = if start < end {
                                    current_minutes >= start && current_minutes < end
                                } else {
                                    // Midnight crossing (e.g., 22:00-06:00)
                                    current_minutes >= start || current_minutes < end
                                };

                                if is_match {
                                    info!(
                                        start = branch.start_time,
                                        end = branch.end_time,
                                        "Matched time branch"
                                    );
                                    match_found = true;

                                    match branch.r#type.as_str() {
                                        "TEXT" => {
                                            outgoing_payload.text = branch.content.clone()
                                        }
                                        "IMAGE" => {
                                            if let Some(url) = &branch.media_url {
                                                outgoing_payload.image =
                                                    Some(MediaPayload { url: url.clone() });
                                                outgoing_payload.caption =
                                                    branch.content.clone();
                                            }
                                        }
                                        "AUDIO" => {
                                            if let Some(url) = &branch.media_url {
                                                outgoing_payload.audio =
                                                    Some(MediaPayload { url: url.clone() });
                                                outgoing_payload.ptt = Some(true);
                                            }
                                        }
                                        _ => {}
                                    }
                                    break;
                                }
                            }
                        }

                        if !match_found {
                            if let Some(fb) = &metadata.fallback {
                                info!("No time match found, using fallback");
                                match fb.r#type.as_str() {
                                    "TEXT" => outgoing_payload.text = fb.content.clone(),
                                    "IMAGE" => {
                                        if let Some(url) = &fb.media_url {
                                            outgoing_payload.image =
                                                Some(MediaPayload { url: url.clone() });
                                            outgoing_payload.caption = fb.content.clone();
                                        }
                                    }
                                    "AUDIO" => {
                                        if let Some(url) = &fb.media_url {
                                            outgoing_payload.audio =
                                                Some(MediaPayload { url: url.clone() });
                                            outgoing_payload.ptt = Some(true);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
            _ => {
                warn!(
                    step_type = step.r#type.as_str(),
                    "Unsupported step type for WhatsApp"
                );
            }
        }

        // XADD to outgoing queue
        if outgoing_payload.text.is_some()
            || outgoing_payload.image.is_some()
            || outgoing_payload.audio.is_some()
        {
            let msg = OutgoingMessage {
                bot_id: session.bot_id.clone(),
                target: session.identifier.clone(),
                execution_id: execution_id.to_string(),
                step_order,
                payload: outgoing_payload,
            };

            if let Ok(json_str) = serde_json::to_string(&msg) {
                let result: redis::RedisResult<String> = redis::cmd("XADD")
                    .arg("agentic:queue:outgoing")
                    .arg("MAXLEN")
                    .arg("~")
                    .arg(10000)
                    .arg("*")
                    .arg("payload")
                    .arg(&json_str)
                    .query_async(&mut state.redis.clone())
                    .await;

                match result {
                    Ok(id) => {
                        info!(
                            stream_id = id,
                            execution_id = execution_id,
                            step_order = step_order,
                            "XADD to agentic:queue:outgoing"
                        );
                    }
                    Err(e) => {
                        error!(
                            error = %e,
                            execution_id = execution_id,
                            "Failed to XADD to outgoing queue"
                        );
                    }
                }
            }
        }
    } else {
        info!(
            platform = session.platform.as_str(),
            identifier = session.identifier,
            step_type = step.r#type.as_str(),
            "Non-WhatsApp platform (not yet supported)"
        );
    }

    Ok(())
}
