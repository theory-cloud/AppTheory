/**
 * Inventory handler - demonstrates inventory-driven multi-Lambda routing.
 */

// In-memory inventory store (for demo purposes)
const inventory = new Map([
    ["item-1", { id: "item-1", name: "Widget A", quantity: 100 }],
    ["item-2", { id: "item-2", name: "Widget B", quantity: 50 }],
    ["item-3", { id: "item-3", name: "Gadget C", quantity: 25 }],
]);

export async function handler(event) {
    const { httpMethod, pathParameters } = event;
    const itemId = pathParameters?.id;

    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    };

    switch (httpMethod) {
        case "GET": {
            const item = inventory.get(itemId);
            if (!item) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: "Item not found", id: itemId }),
                };
            }
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(item),
            };
        }

        case "PUT": {
            const body = event.body ? JSON.parse(event.body) : {};
            const updated = { id: itemId, ...body };
            inventory.set(itemId, updated);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(updated),
            };
        }

        case "DELETE": {
            const existed = inventory.delete(itemId);
            return {
                statusCode: existed ? 204 : 404,
                headers,
                body: existed ? "" : JSON.stringify({ error: "Item not found", id: itemId }),
            };
        }

        default:
            return {
                statusCode: 405,
                headers,
                body: JSON.stringify({ error: "Method not allowed", method: httpMethod }),
            };
    }
}
