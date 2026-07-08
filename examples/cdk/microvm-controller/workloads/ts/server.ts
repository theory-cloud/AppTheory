import { createServer } from "node:http";

const port = Number(process.env.PORT || "8080");

createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      language: "typescript",
      runtime: "apptheory-microvm-workload",
      method: req.method,
      path: req.url,
      now: new Date().toISOString(),
    }),
  );
}).listen(port, "0.0.0.0", () => {
  console.log(`AppTheory TypeScript MicroVM workload listening on :${port}`);
});
