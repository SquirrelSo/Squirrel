# Run Module Backend

## Running the backend locally

To run the backend locally, open three separate terminal windows. (Note: If your path contains spaces, you may need to quote it in PowerShell).

**Window 1 (run-module)**:
`
docker compose -f infra/docker-compose.yml up -d
`

**Window 2 (backend)**:
`
npm run dev
`

**Window 3 (backend)**:
`
npm run worker
`
