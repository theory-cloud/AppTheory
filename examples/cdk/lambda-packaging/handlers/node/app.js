// The layer module and the /opt/bin tool exist only when the layer is
// extracted into /opt; the row asserts both.
const { execFileSync } = require("node:child_process");
const layerGreeting = require("layer-greeting");

exports.handler = async () => {
    const tool = execFileSync("layer-tool", { encoding: "utf8" }).trim();
    return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            greeting: layerGreeting.greet("node"),
            tool,
            optBin: (process.env.PATH || "").split(pathSeparator()).includes("/opt/bin"),
            optLib: (process.env.LD_LIBRARY_PATH || "").split(pathSeparator()).includes("/opt/lib"),
            taskRoot: process.env.LAMBDA_TASK_ROOT || "",
        }),
    };
};

function pathSeparator() {
    return process.platform === "win32" ? ";" : ":";
}
