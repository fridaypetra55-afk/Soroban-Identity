export const IDENTITY_REGISTRY_ERRORS: Record<number, string> = {
  1: 'DID already exists for this address',
  2: 'DID not found',
  3: 'DID is deactivated',
  4: 'Unauthorized: caller is not the controller',
  5: 'Metadata key or value exceeds maximum length',
};

export const CREDENTIAL_MANAGER_ERRORS: Record<number, string> = {
  1: 'Issuer not registered',
  2: 'Credential not found',
  3: 'Credential already revoked',
  4: 'Credential already exists',
  5: 'Credential is expired',
};

export const REPUTATION_ERRORS: Record<number, string> = {
  1: 'Reporter not registered',
  2: 'Subject has no reputation record',
  3: 'Rate limit exceeded for this reporter',
  4: 'Score delta cannot be zero',
};
