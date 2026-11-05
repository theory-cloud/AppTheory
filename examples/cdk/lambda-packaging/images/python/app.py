import json
import os


def handler(event, context):
    with open("/var/task/image-value.txt", encoding="utf-8") as handle:
        image_value = handle.read()
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(
            {
                "runtime": "python-image",
                "imageValue": image_value,
                "taskRoot": os.environ.get("LAMBDA_TASK_ROOT", ""),
            }
        ),
    }
