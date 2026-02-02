/**
 * Basic Lambda handler
 */
export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {
    console.log("Event received:", JSON.stringify(event, null, 2));
    return {
        statusCode: 200,
        body: JSON.stringify({ message: "Hello from AppTheory Lambda!" }),
    };
}
