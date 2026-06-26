#![no_std]

//! Reputation contract — on-chain activity scoring and anti-sybil signals.
//!
//! Trusted reporters (e.g. dApps, oracles) submit score deltas for a subject.
//! The contract accumulates a total score and tracks per-reporter contributions
//! so scores can be audited or disputed.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Env, Symbol, Vec,
};

mod keys;

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol    = symbol_short!("ADMIN");
const REPORTER: Symbol = symbol_short!("REPORTER");

// ── Data types ────────────────────────────────────────────────────────────────

/// Aggregated reputation record for a subject.
#[contracttype]
#[derive(Clone)]
pub struct ReputationRecord {
    pub subject: Address,
    /// Total accumulated score (can be negative)
    pub score: i64,
    /// Number of distinct reporters that have submitted
    pub reporter_count: u32,
    /// Last update timestamp
    pub updated_at: u64,
}

/// A single score submission from a reporter.
#[contracttype]
#[derive(Clone)]
pub struct ScoreEntry {
    pub reporter: Address,
    pub delta: i64,
    pub reason: soroban_sdk::String,
    pub submitted_at: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct Reputation;

#[contractimpl]
impl Reputation {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
    }

    pub fn add_reporter(env: Env, reporter: Address) {
        Self::require_admin(&env);
        let mut reporters = Self::get_reporters(&env);
        if !reporters.contains(&reporter) {
            reporters.push_back(reporter.clone());
            env.storage().instance().set(&REPORTER, &reporters);
        }
    }

    pub fn remove_reporter(env: Env, reporter: Address) {
        Self::require_admin(&env);
        let reporters = Self::get_reporters(&env);
        let mut updated = Vec::new(&env);
        for r in reporters.iter() {
            if r != reporter {
                updated.push_back(r);
            }
        }
        env.storage().instance().set(&REPORTER, &updated);
    }

    // ── Scoring ───────────────────────────────────────────────────────────────

    /// Submit a score delta for a subject. Caller must be a registered reporter.
    pub fn submit_score(
        env: Env,
        reporter: Address,
        subject: Address,
        delta: i64,
        reason: soroban_sdk::String,
    ) {
        reporter.require_auth();
        Self::require_reporter(&env, &reporter);

        let now = env.ledger().timestamp();

        let rec_key = keys::record_key(&subject);
        let mut record: ReputationRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or(ReputationRecord {
                subject: subject.clone(),
                score: 0,
                reporter_count: 0,
                updated_at: now,
            });

        record.score = record.score.saturating_add(delta);
        record.updated_at = now;

        let history_key = keys::history_key(&subject, &reporter);
        let is_new = !env.storage().persistent().has(&history_key);
        if is_new {
            record.reporter_count = record.reporter_count.saturating_add(1);
        }

        env.storage().persistent().set(&rec_key, &record);

        let mut history: Vec<ScoreEntry> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));

        history.push_back(ScoreEntry {
            reporter: reporter.clone(),
            delta,
            reason,
            submitted_at: now,
        });
        env.storage().persistent().set(&history_key, &history);

        env.events()
            .publish((symbol_short!("SCORE"), symbol_short!("updated")), (reporter, subject, delta));
    }

    /// Get the reputation record for a subject.
    pub fn get_reputation(env: Env, subject: Address) -> ReputationRecord {
        let key = keys::record_key(&subject);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(ReputationRecord {
                subject: subject.clone(),
                score: 0,
                reporter_count: 0,
                updated_at: 0,
            })
    }

    /// Get score history submitted by a specific reporter for a subject.
    ///
    /// `offset` — number of entries to skip (0-based).
    /// `limit`  — maximum number of entries to return (capped at 100).
    pub fn get_history(
        env: Env,
        subject: Address,
        reporter: Address,
        offset: u32,
        limit: u32,
    ) -> Vec<ScoreEntry> {
        let key = keys::history_key(&subject, &reporter);
        let all: Vec<ScoreEntry> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));

        let cap: u32 = 100;
        let effective_limit = if limit == 0 || limit > cap { cap } else { limit };
        let len = all.len();
        let start = offset.min(len);
        let end = (start + effective_limit).min(len);

        let mut page = Vec::new(&env);
        for i in start..end {
            page.push_back(all.get(i).unwrap());
        }
        page
    }

    /// Simple anti-sybil check: returns true if score >= threshold AND
    /// at least `min_reporters` distinct reporters have contributed.
    pub fn passes_sybil_check(
        env: Env,
        subject: Address,
        min_score: i64,
        min_reporters: u32,
    ) -> bool {
        let key = keys::record_key(&subject);
        match env.storage().persistent().get::<(Symbol, Address), ReputationRecord>(&key) {
            None => false,
            Some(rec) => rec.score >= min_score && rec.reporter_count >= min_reporters,
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
    }

    fn require_reporter(env: &Env, reporter: &Address) {
        if !Self::get_reporters(env).contains(reporter) {
            panic!("not a registered reporter");
        }
    }

    fn get_reporters(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&REPORTER)
            .unwrap_or_else(|| Vec::new(env))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    #[test]
    fn test_score_accumulation() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin    = Address::generate(&env);
        let reporter = Address::generate(&env);
        let subject  = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter);

        let reason = String::from_str(&env, "completed KYC");
        client.submit_score(&reporter, &subject, &50, &reason);
        client.submit_score(&reporter, &subject, &25, &reason);

        let rec = client.get_reputation(&subject);
        assert_eq!(rec.score, 75);
        assert_eq!(rec.reporter_count, 1); // same reporter
    }

    #[test]
    fn test_get_history_pagination() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin    = Address::generate(&env);
        let reporter = Address::generate(&env);
        let subject  = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter);

        // Submit 5 entries
        for i in 0..5_i64 {
            let reason = String::from_str(&env, "reason");
            client.submit_score(&reporter, &subject, &i, &reason);
        }

        // First page: offset=0, limit=2 → entries 0,1
        let page1 = client.get_history(&subject, &reporter, &0, &2);
        assert_eq!(page1.len(), 2);
        assert_eq!(page1.get(0).unwrap().delta, 0);
        assert_eq!(page1.get(1).unwrap().delta, 1);

        // Second page: offset=2, limit=2 → entries 2,3
        let page2 = client.get_history(&subject, &reporter, &2, &2);
        assert_eq!(page2.len(), 2);
        assert_eq!(page2.get(0).unwrap().delta, 2);

        // Last page: offset=4, limit=10 → only entry 4 remains
        let page3 = client.get_history(&subject, &reporter, &4, &10);
        assert_eq!(page3.len(), 1);
        assert_eq!(page3.get(0).unwrap().delta, 4);

        // Offset beyond length → empty
        let empty = client.get_history(&subject, &reporter, &99, &10);
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn test_sybil_check() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let reporter1 = Address::generate(&env);
        let reporter2 = Address::generate(&env);
        let subject   = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter1);
        client.add_reporter(&reporter2);

        let reason = String::from_str(&env, "activity");
        client.submit_score(&reporter1, &subject, &40, &reason);
        client.submit_score(&reporter2, &subject, &40, &reason);

        // score=80, reporters=2 — should pass
        assert!(client.passes_sybil_check(&subject, &50, &2));
        // requires 3 reporters — should fail
        assert!(!client.passes_sybil_check(&subject, &50, &3));
    }

    /// submit_score must panic when the reporter is not registered.
    #[test]
    #[should_panic]
    fn test_submit_score_unauthorized_reporter() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin    = Address::generate(&env);
        let reporter = Address::generate(&env); // never added as reporter
        let subject  = Address::generate(&env);

        client.initialize(&admin);

        let reason = String::from_str(&env, "unauthorized");
        client.submit_score(&reporter, &subject, &10, &reason);
    }

    /// passes_sybil_check returns false when score is below the minimum threshold.
    #[test]
    fn test_sybil_check_score_threshold() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin    = Address::generate(&env);
        let reporter = Address::generate(&env);
        let subject  = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter);

        let reason = String::from_str(&env, "activity");
        client.submit_score(&reporter, &subject, &30, &reason);

        // score=30, reporters=1 — passes with matching thresholds
        assert!(client.passes_sybil_check(&subject, &30, &1));
        // score=30 is below min_score=50 — must fail
        assert!(!client.passes_sybil_check(&subject, &50, &1));
    }

    /// passes_sybil_check returns false for a subject with no reputation record at all.
    #[test]
    fn test_sybil_check_no_record() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let subject = Address::generate(&env); // no history
        // Even with zero thresholds the contract returns false when no record exists
        assert!(!client.passes_sybil_check(&subject, &0, &0));
    }

    /// get_history returns only entries submitted by the specified reporter.
    #[test]
    fn test_get_history_per_reporter() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let reporter1 = Address::generate(&env);
        let reporter2 = Address::generate(&env);
        let subject   = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter1);
        client.add_reporter(&reporter2);

        let r1 = String::from_str(&env, "reporter1 reason");
        let r2 = String::from_str(&env, "reporter2 reason");
        client.submit_score(&reporter1, &subject, &10, &r1);
        client.submit_score(&reporter1, &subject, &20, &r1);
        client.submit_score(&reporter2, &subject, &99, &r2);

        let h1 = client.get_history(&subject, &reporter1, &0, &10);
        assert_eq!(h1.len(), 2);
        assert_eq!(h1.get(0).unwrap().delta, 10);
        assert_eq!(h1.get(1).unwrap().delta, 20);

        let h2 = client.get_history(&subject, &reporter2, &0, &10);
        assert_eq!(h2.len(), 1);
        assert_eq!(h2.get(0).unwrap().delta, 99);
    }
}
