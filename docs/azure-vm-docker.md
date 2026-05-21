# Azure VM Docker Deployment (No Custom Domain)

This guide deploys the app to an Ubuntu Azure VM using Docker Compose with `app`, `postgres`, and `caddy`. HTTPS uses the Azure public IP DNS label (no custom domain).

## Prerequisites

- Ubuntu 24.04 LTS VM in Azure
- Static public IP (Standard SKU)
- DNS name label set on the public IP
- Ports 80 and 443 open to the Internet, port 22 restricted to your admin IP

The public endpoint looks like:

`https://<label>.<region>.cloudapp.azure.com`

## 1) Create VM + public IP

1. Create an Ubuntu 24.04 LTS VM (B1s for light use, B2s for more headroom).
2. Use SSH key auth only.
3. Create or attach a Standard SKU public IP with static allocation.
4. Set a DNS name label on the public IP in the Azure portal.

References:

- https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses
- https://learn.microsoft.com/en-us/azure/virtual-machines/create-fqdn

## 2) Configure NSG inbound rules

Allow only these inbound rules:

- 22/tcp from your admin IP
- 80/tcp from Internet (ACME cert issuance)
- 443/tcp from Internet (HTTPS traffic)

Do not expose ports 3000 or 5432.

Reference:

- https://learn.microsoft.com/en-us/azure/architecture/networking/guide/network-level-segmentation

## 3) Install Docker and Compose

On the VM:

```
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

## 4) Configure environment

From the repo root on the VM:

1. Copy the production env template:

```
cp .env.production.example .env.production
```

2. Edit `.env.production` with real values:
   - `CADDY_HOST=<label>.<region>.cloudapp.azure.com`
   - `POSTGRES_PASSWORD=<strong password>`
   - `DATABASE_URL=postgres://opg:<password>@postgres:5432/opg?sslmode=disable`
   - `GOOGLE_REDIRECT_URI=https://<label>.<region>.cloudapp.azure.com/oauth/google/callback`
   - Slack, JazzHR, Google OAuth, and `APP_ENCRYPTION_KEY`

## 5) Start the stack

```
docker compose up -d --build
```

Check status:

```
docker compose ps
```

Check app logs:

```
docker compose logs -f app
```

## 6) Verify health

```
curl https://<label>.<region>.cloudapp.azure.com/health
```

Expected logs include:

- `health_server_started`
- `slack_app_started`

## 7) Updates

```
git pull

docker compose up -d --build
```

## 8) Backups

Create a SQL backup on the VM:

```
docker compose exec postgres pg_dump -U opg opg > backup.sql
```

Copy the backup off the VM:

```
scp backup.sql <user>@<vm-ip>:/path/to/save
```

## 9) Restore

```
docker compose exec -T postgres psql -U opg opg < backup.sql
```

## 10) Troubleshooting

- If HTTPS fails, ensure port 80 is open and `CADDY_HOST` matches the Azure DNS label.
- If the app cannot connect to Postgres, confirm `DATABASE_URL` matches the Compose service name `postgres`.
- Use `docker compose logs caddy` and `docker compose logs app` for TLS and app errors.
- Slack uses Socket Mode, so no public request URL is required.
