# Sandbox workspaces (Round J)

If Docker is installed, WeBrain can give the AI a long-lived Linux container to work in. Files installed packages (apt-get, pip install) survive between calls — the AI can actually iterate on a real environment instead of starting from scratch every turn.

Create a workspace from the admin Sandbox page, enable network if needed, optionally restrict outbound to a whitelist of domains. The bind mount lives at `~/.webrain/workspaces/<id>/` and survives container restarts.
