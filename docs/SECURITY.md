# Security Policy

ARETE is an open, ethics-first reasoning assistant built for transparency and auditability.  
Security, in this context, means protecting **technical integrity**, ensuring **ethical safety**, and preserving **data provenance**.

---

## Supported Versions

ARETE is in **active development (pre-1.0)**.  
Security updates are applied continuously on the `main` branch and deployed to Fly.io through verified GitHub Actions.

| Version | Supported | Notes |
|----------|------------|-------|
| `main`  | ✅ Active | Live development and deployment |
| `< 0.1.0` | ❌ | Deprecated (Daneel legacy code) |

---

## Reporting a Vulnerability

If you discover a **security**, **privacy**, or **ethical-safety** issue (such as data leakage, unsafe behavior, or prompt injection):

1. **Do not open a public GitHub issue.**  
   Instead, email the maintainer directly:  
   **security.arete@proton.me**

2. Include:
   - A clear description of the issue and potential impact.  
   - Steps to reproduce, if possible.  

3. You’ll receive an acknowledgment within **72 hours**.  
   Responsible disclosures will be credited in release notes once resolved.

---

## Deployment & Infrastructure Notes

- **Hosting:** Fly.io (containerized Node.js app)  
- **Local development:** Uses a `.env` file for environment variables; **never commit this file** or share it outside your local machine.  
  - Add `.env` to `.gitignore` (already recommended).  
  - If secrets are ever leaked, rotate them immediately and delete the file from history using `git filter-repo` or GitHub's Secret Scanning guidance.  
- **Runtime isolation:** Each deployment runs as a single app VM with auto-scaling off by default.  
- **Secrets:** Managed via Fly secrets (`fly secrets set`) and never committed to version control.  
- **Dependencies:** Monitored by Dependabot on a cycle.  
- **Vulnerability scanning:** Performed automatically via GitHub's built-in advisories.
- **Incident pseudonymization:** Discord identifiers (guild, channel, message, user) are HMAC-SHA256 hashed with a namespaced input (e.g., `guild:<id>`) using `INCIDENT_PSEUDONYMIZATION_SECRET`. Store the full 64-hex digest for uniqueness; only show short prefixes (10-12 chars) in logs or admin views. Rotate the secret if exposure is suspected and treat unhashed legacy rows as sensitive data until backfilled.

---

## Ethical Safety & Incident Response

ARETE treats **ethical failures as security incidents**.  
If you encounter behavior that could cause real-world harm (e.g., unsafe advice, biased reasoning, coercive responses):

- Report it via **“Report Issue”** button in Discord under each response.  
- Each confirmed case is logged in `docs/INCIDENTS.md` with anonymized context.
- Recurrent failures trigger review and escalation to the Ethics Advisory process.

---

## Guiding Principle

> “Honesty is the first chapter in the book of wisdom.” – Thomas Jefferson
> “The more hidden the mechanism, the more powerful it becomes.” – Hannah Arendt

Thank you for helping make ARETE safer, more trustworthy, and more accountable.
