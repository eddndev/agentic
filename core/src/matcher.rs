use crate::models::db::{MatchType, Trigger};

pub struct MatchResult {
    pub trigger: Trigger,
}

/// Priority-based trigger matching: EXACT → CONTAINS.
/// Replicates TriggerMatcher.ts behavior.
pub fn find_match(content: &str, triggers: &[Trigger]) -> Option<MatchResult> {
    let normalized = content.trim().to_lowercase();

    if normalized.is_empty() {
        return None;
    }

    // 1. EXACT matches (highest priority)
    for t in triggers {
        if t.match_type == MatchType::EXACT && t.keyword.to_lowercase() == normalized {
            return Some(MatchResult {
                trigger: t.clone(),
            });
        }
    }

    // 2. CONTAINS matches
    for t in triggers {
        if t.match_type == MatchType::CONTAINS && normalized.contains(&t.keyword.to_lowercase()) {
            return Some(MatchResult {
                trigger: t.clone(),
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::db::TriggerScope;
    use chrono::Utc;

    fn make_trigger(keyword: &str, match_type: MatchType) -> Trigger {
        Trigger {
            id: format!("trigger-{}", keyword),
            bot_id: "bot-1".to_string(),
            session_id: None,
            keyword: keyword.to_string(),
            match_type,
            is_active: true,
            flow_id: "flow-1".to_string(),
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            scope: TriggerScope::INCOMING,
            cooldown_ms: None,
            usage_limit: None,
            excludes_flows: None,
        }
    }

    #[test]
    fn exact_match_case_insensitive() {
        let triggers = vec![make_trigger("hello", MatchType::EXACT)];
        let result = find_match("HELLO", &triggers);
        assert!(result.is_some());
        assert_eq!(result.unwrap().trigger.keyword, "hello");
    }

    #[test]
    fn exact_match_with_whitespace() {
        let triggers = vec![make_trigger("hello", MatchType::EXACT)];
        let result = find_match("  hello  ", &triggers);
        assert!(result.is_some());
    }

    #[test]
    fn exact_no_partial_match() {
        let triggers = vec![make_trigger("hello", MatchType::EXACT)];
        let result = find_match("hello world", &triggers);
        assert!(result.is_none());
    }

    #[test]
    fn contains_match() {
        let triggers = vec![make_trigger("promo", MatchType::CONTAINS)];
        let result = find_match("check out this promo code", &triggers);
        assert!(result.is_some());
    }

    #[test]
    fn contains_case_insensitive() {
        let triggers = vec![make_trigger("PROMO", MatchType::CONTAINS)];
        let result = find_match("check out this promo code", &triggers);
        assert!(result.is_some());
    }

    #[test]
    fn exact_has_priority_over_contains() {
        let triggers = vec![
            make_trigger("hello", MatchType::CONTAINS),
            make_trigger("hello", MatchType::EXACT),
        ];
        let result = find_match("hello", &triggers);
        assert!(result.is_some());
        assert_eq!(result.unwrap().trigger.id, "trigger-hello"); // EXACT one
    }

    #[test]
    fn empty_content_returns_none() {
        let triggers = vec![make_trigger("hello", MatchType::EXACT)];
        let result = find_match("", &triggers);
        assert!(result.is_none());
    }

    #[test]
    fn whitespace_only_returns_none() {
        let triggers = vec![make_trigger("hello", MatchType::EXACT)];
        let result = find_match("   ", &triggers);
        assert!(result.is_none());
    }

    #[test]
    fn no_triggers_returns_none() {
        let result = find_match("hello", &[]);
        assert!(result.is_none());
    }
}
