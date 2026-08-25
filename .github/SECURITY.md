# Security

Guma holds client contact details, pricing, and files a customer considers
their intellectual property. Please report anything that could expose those
privately rather than in a public issue.

Email the maintainer listed on the repository. Expect an acknowledgement within
a few days; this is a small project, not a company with an on-call rota.

## Please do report

- Anything that lets one shop read another shop's data (a row-level security
  gap)
- Anything that exposes uploaded client files
- Authentication bypass of any kind
- Secrets committed to the repository

## Known and accepted

- The Supabase publishable key is compiled into the client bundle. That is by
  design — it is public, and row-level security is what protects the data.
- Self-hosted installs are as secure as the Postgres and reverse proxy they run
  behind. Guma does not manage that for you.
