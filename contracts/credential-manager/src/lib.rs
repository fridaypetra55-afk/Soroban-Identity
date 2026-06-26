#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env, Map, String, Vec};

mod types;
mod keys;
mod issuer;
mod credential;
mod revocation;

pub use types::{Credential, CredentialType};

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct CredentialManager;

#[contractimpl]
impl CredentialManager {
    pub fn initialize(env: Env, admin: Address) {
        issuer::initialize(&env, admin);
    }

    pub fn add_issuer(env: Env, issuer: Address) {
        issuer::add_issuer(&env, issuer);
    }

    pub fn remove_issuer(env: Env, issuer: Address) {
        issuer::remove_issuer(&env, issuer);
    }

    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        signature: Bytes,
        expires_at: u64,
    ) -> BytesN<32> {
        credential::issue_credential(
            &env, issuer, subject, credential_type, claims, signature, expires_at,
        )
    }

    pub fn revoke_credential(env: Env, issuer: Address, credential_id: BytesN<32>) {
        revocation::revoke_credential(&env, issuer, credential_id);
    }

    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> bool {
        revocation::verify_credential(&env, credential_id)
    }

    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Credential {
        credential::get_credential(&env, credential_id)
    }

    pub fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        credential::get_subject_credentials(&env, subject)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Bytes, Env, Map, String};

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    /// issue_credential stores the credential and verify_credential returns true.
    #[test]
    fn test_issue_and_verify() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &claims,
            &sig,
            &0u64,
        );

        assert!(client.verify_credential(&cred_id));
    }

    /// revoke_credential marks the credential revoked; verify_credential returns false.
    #[test]
    fn test_revoke_credential() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        client.revoke_credential(&issuer, &cred_id);
        assert!(!client.verify_credential(&cred_id));
    }

    /// issue_credential must panic when the caller is not a registered issuer.
    #[test]
    #[should_panic]
    fn test_issue_unauthorized_issuer() {
        let (env, _admin, client) = setup();

        let unauthorized = Address::generate(&env); // NOT registered
        let subject = Address::generate(&env);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        client.issue_credential(
            &unauthorized, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );
    }

    /// verify_credential returns false once the credential's expiry timestamp has passed.
    #[test]
    fn test_verify_expired_credential() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let expires_at = env.ledger().timestamp() + 100;

        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &expires_at,
        );

        // Valid before expiry
        assert!(client.verify_credential(&cred_id));

        // Advance ledger past expiry
        env.ledger().with_mut(|li| {
            li.timestamp = expires_at + 1;
        });

        // Must be invalid after expiry
        assert!(!client.verify_credential(&cred_id));
    }

    /// revoke_credential must panic when called by an address that did not issue the credential.
    #[test]
    #[should_panic]
    fn test_revoke_by_different_issuer() {
        let (env, _admin, client) = setup();

        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);

        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer1, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        // issuer2 attempts to revoke a credential they did not issue
        client.revoke_credential(&issuer2, &cred_id);
    }

    /// get_credential returns all fields exactly as supplied at issuance.
    #[test]
    fn test_credential_stored_correctly() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let mut claims: Map<String, String> = Map::new(&env);
        claims.set(
            String::from_str(&env, "name"),
            String::from_str(&env, "Alice"),
        );
        let sig = Bytes::from_array(&env, &[1u8; 64]);
        let expires_at = 9999u64;

        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Achievement, &claims, &sig, &expires_at,
        );

        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
        assert_eq!(cred.credential_type, CredentialType::Achievement);
        assert_eq!(cred.expires_at, expires_at);
        assert!(!cred.revoked);
    }
}
