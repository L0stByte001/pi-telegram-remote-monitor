FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json controller.mjs ./

USER node

EXPOSE 47831

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const net=require('node:net');const s=net.connect(47831,'127.0.0.1');s.setTimeout(3000);s.on('connect',()=>{s.end();process.exit(0)});s.on('timeout',()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(1))"

CMD ["node", "--use-env-proxy", "controller.mjs"]
