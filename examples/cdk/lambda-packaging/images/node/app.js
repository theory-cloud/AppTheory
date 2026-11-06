const fs = require("node:fs");

exports.handler = async () => {
    const imageValue = fs.readFileSync("/var/task/image-value.txt", "utf8");
    return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            runtime: "node-image",
            imageValue,
            taskRoot: process.env.LAMBDA_TASK_ROOT || "",
        }),
    };
};
