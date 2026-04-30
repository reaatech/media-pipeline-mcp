# Security Policy — media-pipeline-mcp

This document outlines the security controls, vulnerability reporting process, and compliance considerations for media-pipeline-mcp.

---

## Security Controls

### Authentication & Authorization

- **API Key Authentication**: Configure API keys via environment variables or secrets manager
- **JWT/OAuth2**: Support for enterprise SSO integration
- **Role-Based Access Control (RBAC)**: Three roles (admin, operator, viewer) with granular permissions
- **Per-tool permissions**: Fine-grained access control is enforced on MCP tool calls

### Rate Limiting

- **Per-client limits**: Configurable requests per minute with burst capacity
- **Per-operation limits**: Protect expensive operations such as image/video generation and TTS
- **Global limits**: System-wide protection against abuse
- **Token bucket algorithm**: Fair rate limiting with burst support

### Audit Logging

- **Immutable audit trail**: All operations logged with actor, action, outcome
- **SIEM integration**: Export to Splunk, Datadog, Sumo Logic
- **Retention policies**: Configurable retention (default 7 years for compliance)
- **Local backup**: JSONL files stored locally as backup

### Data Protection

- **Encryption at rest**: Storage adapters support KMS encryption
- **Encryption in transit**: TLS 1.3 enforced in production
- **PII redaction**: Automatic PII detection and redaction in logs
- **Secrets management**: Integration with Vault, AWS Secrets Manager, GCP Secret Manager

### Content Safety

- **Prompt screening**: Block prohibited content in prompts
- **Output moderation**: NSFW detection for generated images
- **Configurable policies**: Per-tenant safety policies

---

## Vulnerability Reporting

We take security vulnerabilities seriously. If you discover a security issue:

1. **Do NOT** create a public GitHub issue
2. Email security@reaatech.com with details
3. Include steps to reproduce the issue
4. We will respond within 48 hours

### Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x.x   | ✅        |

---

## Security Best Practices

### For Operators

1. **Never commit secrets**: Use environment variables or secrets manager
2. **Rotate API keys regularly**: Set up automated rotation
3. **Enable audit logging**: Configure SIEM export for compliance
4. **Set rate limits**: Protect against abuse and cost overruns
5. **Use TLS in production**: Never run without encryption
6. **Monitor costs**: Set up budget alerts

### For Developers

1. **Input validation**: All inputs validated with Zod schemas
2. **Dependency scanning**: npm audit and Snyk in CI
3. **Secret scanning**: gitleaks pre-commit hooks
4. **Security headers**: CSP, HSTS, X-Frame-Options

---

## Compliance Considerations

### GDPR

- **Data minimization**: Only collect necessary data
- **Right to deletion**: API endpoints for data deletion
- **Data export**: Export all data for a user on request
- **Data residency**: Region-locked storage options

### SOC 2

- **Access controls**: RBAC and audit logging
- **Change management**: CI/CD with approvals
- **Incident response**: Documented runbooks
- **Vendor management**: Provider security assessments

### HIPAA

- **BAAs available**: For covered entities
- **Encryption**: At rest and in transit
- **Access logging**: Comprehensive audit trail
- **Data segregation**: Tenant isolation

---

## Security Configuration

### Minimum Production Configuration

```typescript
// media-pipeline-mcp.config.ts
export default {
  security: {
    requireAuth: true,
    jwtSecret: process.env.JWT_SECRET,
    apiKeys: new Map([
      ['key-1', { userId: 'service-1', permissions: ['pipeline:run', 'artifact:read'] }]
    ]),
    rateLimit: {
      clientRequestsPerMinute: 60,
      clientBurstSize: 10,
      expensiveOperationsPerMinute: 10,
      globalRequestsPerSecond: 100
    },
    audit: {
      retentionDays: 2555, // 7 years
      splunkEndpoint: process.env.SPLUNK_ENDPOINT,
      splunkToken: process.env.SPLUNK_TOKEN
    }
  }
};
```

---

## Incident Response

### Security Incident Process

1. **Detection**: Automated monitoring or manual report
2. **Triage**: Assess severity and impact
3. **Containment**: Isolate affected systems
4. **Investigation**: Determine root cause
5. **Remediation**: Fix vulnerability
6. **Recovery**: Restore normal operations
7. **Post-mortem**: Document lessons learned

### Contact

- **Security Email**: security@reaatech.com
- **PGP Key**: Available on request
- **Incident Hotline**: See repository for contact details (24/7 for critical incidents)
