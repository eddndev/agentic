use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    #[sqlx(rename = "flowId")]
    pub flow_id: String,
    pub r#type: String,
    pub content: Option<String>,
    #[sqlx(rename = "mediaUrl")]
    pub media_url: Option<String>,
    pub metadata: Option<serde_json::Value>,
    #[sqlx(rename = "delayMs")]
    pub delay_ms: i32,
    #[sqlx(rename = "jitterPct")]
    pub jitter_pct: i32,
    pub order: i32,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Execution {
    pub id: String,
    #[sqlx(rename = "sessionId")]
    pub session_id: String,
    #[sqlx(rename = "flowId")]
    pub flow_id: String,
    #[sqlx(rename = "platformUserId")]
    pub platform_user_id: String,
    pub status: String,
    #[sqlx(rename = "currentStep")]
    pub current_step: i32,
    #[sqlx(rename = "variableContext")]
    pub variable_context: Option<serde_json::Value>,
    #[sqlx(rename = "startedAt")]
    pub started_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    #[sqlx(rename = "completedAt")]
    pub completed_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub platform: String,
    pub identifier: String,
    #[sqlx(rename = "botId")]
    pub bot_id: String,
    pub name: Option<String>,
    pub status: String,
    #[sqlx(rename = "authData")]
    pub auth_data: Option<serde_json::Value>,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Trigger {
    pub id: String,
    #[sqlx(rename = "botId")]
    pub bot_id: String,
    #[sqlx(rename = "sessionId")]
    pub session_id: Option<String>,
    pub keyword: String,
    #[sqlx(rename = "matchType")]
    pub match_type: String,
    #[sqlx(rename = "isActive")]
    pub is_active: bool,
    #[sqlx(rename = "flowId")]
    pub flow_id: String,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub scope: String,
    // Joined fields from Flow (populated via query alias)
    #[sqlx(rename = "cooldownMs")]
    pub cooldown_ms: Option<i32>,
    #[sqlx(rename = "usageLimit")]
    pub usage_limit: Option<i32>,
    #[sqlx(rename = "excludesFlows")]
    pub excludes_flows: Option<Vec<String>>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Flow {
    pub id: String,
    #[sqlx(rename = "botId")]
    pub bot_id: String,
    pub name: String,
    pub description: Option<String>,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    #[sqlx(rename = "cooldownMs")]
    pub cooldown_ms: i32,
    #[sqlx(rename = "usageLimit")]
    pub usage_limit: i32,
    #[sqlx(rename = "excludesFlows")]
    pub excludes_flows: Vec<String>,
}
