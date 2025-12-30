# Ma Sói Server

Backend server cho game Ma Sói Mobile.

## Deploy trên Render

Server này được deploy tự động từ GitHub lên Render.

## Local Development

```bash
npm install
npm run dev
```

Server sẽ chạy tại `http://localhost:3000`

## Environment Variables

- `PORT`: Port server (mặc định: 3000)
- `NODE_ENV`: Environment (development/production)

## Endpoints

- `GET /`: Health check
- `GET /health`: Health status
- Socket.IO events: `CREATE_ROOM`, `JOIN_ROOM`, `START_GAME`
