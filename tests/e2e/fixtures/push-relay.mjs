// A stand-in for a browser push service. It answers 201 the way a real relay
// does and records what arrived, so a test can prove the server encrypted and
// signed a delivery without reaching the internet.
//
// It records metadata only. The body is an RFC 8291 encrypted record and the
// endpoint path is a delivery secret, so neither is kept.

import { createServer } from "node:http";

const port = Number(process.env.CLICKCLACK_PUSH_RELAY_PORT || 18084);
const deliveries = [];

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.url === "/deliveries") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(deliveries));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405);
    response.end();
    return;
  }
  let length = 0;
  request.on("data", (chunk) => {
    length += chunk.length;
  });
  request.on("end", () => {
    deliveries.push({
      authorization: String(request.headers.authorization || "").slice(0, 6),
      hasVapidToken: /^vapid t=[^,]+, k=.+$/.test(String(request.headers.authorization || "")),
      contentEncoding: request.headers["content-encoding"],
      contentType: request.headers["content-type"],
      ttl: request.headers.ttl,
      urgency: request.headers.urgency,
      encryptedBytes: length,
    });
    response.writeHead(201);
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`push relay listening on ${port}\n`);
});
