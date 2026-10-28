FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server ./server
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=47821 DATA_DIR=/data
USER node
EXPOSE 47821
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||47821)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/cli.mjs"]
