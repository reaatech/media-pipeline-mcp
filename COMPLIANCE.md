# Compliance Documentation — media-pipeline-mcp

This document outlines compliance considerations, certifications, and regulatory requirements for media-pipeline-mcp deployments.

---

## Supported Compliance Frameworks

### SOC 2 Type II

media-pipeline-mcp is designed to support SOC 2 compliance requirements.

#### Access Controls
- **Authentication**: API key, JWT/OAuth2 support for enterprise SSO
- **Authorization**: Role-based access control (RBAC) with admin, operator, viewer roles
- **Audit Logging**: Immutable audit trail for all operations (see `SECURITY.md`)

#### Change Management
- **CI/CD Pipeline**: Automated deployments with GitHub Actions
- **Code Review**: All changes require pull request approval
- **Deployment Approval**: Production deployments require CI to pass

#### Incident Response
- **Documented Runbook**: Available in `SECURITY.md`
- **Response Procedures**: Defined security incident process
- **Notification**: 48-hour response for vulnerability reports

#### Vendor Management
- **Provider Security**: All external providers (OpenAI, Stability AI, etc.) have their own SOC 2 certifications
- **Data Processing**: Provider API calls are logged but not stored long-term

---

### GDPR (General Data Protection Regulation)

media-pipeline-mcp processes user data through external AI providers. The following GDPR considerations apply:

#### Data Minimization
- Only necessary data is collected for operation
- Artifacts are automatically expired based on TTL configuration
- No personally identifiable information (PII) is stored in logs

#### Data Subject Rights
| Right | Implementation |
|-------|----------------|
| Access | `media.artifact.list` API returns all artifacts for a session |
| Deletion | `media.artifact.delete` API for explicit deletion |
| Portability | Artifacts can be exported via signed URLs |
| Rectification | Re-process with corrected inputs |

#### Data Residency
- **Storage**: Configurable to use regional storage (S3 buckets, GCS buckets)
- **Providers**: Different providers have different data residency policies
- **Default**: US-East-1 for AWS, us-central1 for GCP

#### Legal Basis for Processing
- Users submit prompts which are processed by third-party AI providers
- Each provider has their own privacy policy and data processing agreement
- DPA templates available for enterprise contracts

---

### HIPAA (Health Insurance Portability and Accountability Act)

For healthcare deployments, additional configuration is required:

#### Business Associate Agreement (BAA)
- BAAs available for covered entities using enterprise plans
- Contact sales for BAA execution

#### Technical Safeguards
- **Encryption**: TLS 1.3 in transit, KMS encryption at rest
- **Access Controls**: RBAC with audit logging
- **Transmission Security**: All provider API calls over HTTPS

#### Deployment Requirements
- Dedicated tenant isolation (not multi-tenant)
- Private cloud deployment (AWS GovCloud or equivalent)
- AWS PrivateLink or GCP VPC Service Controls for provider connectivity

---

## Data Processing Agreement (DPA)

A standard DPA is available for enterprise customers covering:

- **Processing Scope**: What data is processed and how
- **Sub-processors**: List of third-party providers
- **Security Measures**: Technical and organizational safeguards
- **Breach Notification**: 72-hour notification requirement
- **Data Return/Deletion**: Procedures for contract termination

Contact your sales representative or email legal@media-pipeline.dev for DPA execution.

---

## Export Compliance

### US Export Regulations
- This software is classified under ECCN 7D003
- Distributed under commercial license

### EU Export Regulations
- Dual-use item classification may apply
- Consult export compliance team for international deployments

---

## Security Assessments

### Penetration Testing
- Annual third-party penetration test
- Results available to enterprise customers under NDA

### Vulnerability Scanning
- Automated scanning via Trivy in CI/CD pipeline
- npm audit for dependency vulnerabilities
- Critical vulnerabilities addressed within 24 hours

### Security Certifications
- SOC 2 Type II (annual audit)
- ISO 27001 (planned Q4 2026)

---

## Audit Log Retention

| Log Type | Default Retention | Configurable |
|----------|------------------|--------------|
| Audit Logs | 7 years | Yes (min 1 year) |
| Cost Records | 7 years | Yes |
| Pipeline Metadata | 2 years | Yes |
| Artifact Metadata | TTL-based | Yes (via storage config) |

SIEM integration available for:
- Splunk
- Datadog
- Sumo Logic
- Custom webhook endpoint

---

## Incident Response Runbook

### Severity Classification

| Severity | Definition | Response Time |
|----------|-----------|---------------|
| Critical | Production down, data breach | 1 hour |
| High | Significant degradation, potential breach | 4 hours |
| Medium | Minor degradation, no data impact | 24 hours |
| Low | Cosmetic issues, inquiries | 72 hours |

### Response Procedures

1. **Detection**: Automated monitoring or customer report
2. **Triage**: On-call engineer assesses severity
3. **Containment**: Isolate affected systems, revoke compromised credentials
4. **Investigation**: Root cause analysis with timeline
5. **Remediation**: Deploy fix, validate resolution
6. **Notification**: Notify affected customers within required timeframe
7. **Post-mortem**: Document lessons learned within 2 weeks

### Contact Information

- **Security Email**: security@media-pipeline.dev
- **Incident Hotline**: Available for Critical severity incidents
- **PGP Key**: Available on request

---

## Compliance Configuration

### Minimum Production Configuration

```typescript
// media-pipeline-mcp.config.ts
export default {
  security: {
    auditRetentionDays: 2555, // 7 years
    encryptionAtRest: true,
    tlsEnforced: true
  },
  storage: {
    type: 's3',
    bucket: 'compliant-artifact-storage',
    region: 'us-east-1',
    kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/...' // Customer managed key
  }
};
```

### GDPR-Compliant Configuration

```typescript
export default {
  security: {
    requireAuth: true,
    piiRedaction: true
  },
  storage: {
    type: 's3',
    region: 'eu-west-1', // EU data residency
    lifecycle: {
      expiration: 30 // Auto-delete after 30 days
    }
  }
};
```

---

## Attestation and Certifications

Enterprise customers can request:
- SOC 2 Type II audit report (NDA required)
- Penetration test summary (NDA required)
- ISO 27001 certificate
- Custom DPA execution
- Security questionnaire responses (CISO sign-off)

Contact your account manager or email compliance@media-pipeline.dev.

---

*Last updated: April 2026*
*Next review: October 2026*