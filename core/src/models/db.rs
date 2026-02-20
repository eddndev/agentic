use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// --- Prisma Enums (mapped to Postgres USER-DEFINED types) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "StepType")]
#[allow(non_camel_case_types)]
pub enum StepType {
    TEXT,
    IMAGE,
    AUDIO,
    VIDEO,
    DOCUMENT,
    PTT,
    CONDITIONAL_TIME,
}

impl StepType {
    pub fn as_str(&self) -> &str {
        match self {
            StepType::TEXT => "TEXT",
            StepType::IMAGE => "IMAGE",
            StepType::AUDIO => "AUDIO",
            StepType::VIDEO => "VIDEO",
            StepType::DOCUMENT => "DOCUMENT",
            StepType::PTT => "PTT",
            StepType::CONDITIONAL_TIME => "CONDITIONAL_TIME",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "MatchType")]
pub enum MatchType {
    EXACT,
    CONTAINS,
    REGEX,
}

impl MatchType {
    pub fn as_str(&self) -> &str {
        match self {
            MatchType::EXACT => "EXACT",
            MatchType::CONTAINS => "CONTAINS",
            MatchType::REGEX => "REGEX",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "TriggerScope")]
pub enum TriggerScope {
    INCOMING,
    OUTGOING,
    BOTH,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "Platform")]
pub enum Platform {
    WHATSAPP,
    TELEGRAM,
}

impl Platform {
    pub fn as_str(&self) -> &str {
        match self {
            Platform::WHATSAPP => "WHATSAPP",
            Platform::TELEGRAM => "TELEGRAM",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "SessionStatus")]
pub enum SessionStatus {
    CONNECTED,
    DISCONNECTED,
    AUTHENTICATING,
    FAILED,
}

// --- Database Models ---

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    #[sqlx(rename = "flowId")]
    pub flow_id: String,
    pub r#type: StepType,
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
    pub created_at: NaiveDateTime,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: NaiveDateTime,
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
    pub started_at: NaiveDateTime,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: NaiveDateTime,
    #[sqlx(rename = "completedAt")]
    pub completed_at: Option<NaiveDateTime>,
    pub error: Option<String>,
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub platform: Platform,
    pub identifier: String,
    #[sqlx(rename = "botId")]
    pub bot_id: String,
    pub name: Option<String>,
    pub status: SessionStatus,
    #[sqlx(rename = "authData")]
    pub auth_data: Option<serde_json::Value>,
    #[sqlx(rename = "createdAt")]
    pub created_at: NaiveDateTime,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: NaiveDateTime,
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
    pub match_type: MatchType,
    #[sqlx(rename = "isActive")]
    pub is_active: bool,
    #[sqlx(rename = "flowId")]
    pub flow_id: String,
    #[sqlx(rename = "createdAt")]
    pub created_at: NaiveDateTime,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: NaiveDateTime,
    pub scope: TriggerScope,
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
    pub created_at: NaiveDateTime,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: NaiveDateTime,
    #[sqlx(rename = "cooldownMs")]
    pub cooldown_ms: i32,
    #[sqlx(rename = "usageLimit")]
    pub usage_limit: i32,
    #[sqlx(rename = "excludesFlows")]
    pub excludes_flows: Vec<String>,
}
