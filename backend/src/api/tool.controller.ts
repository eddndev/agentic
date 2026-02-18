import { Elysia, t } from "elysia";
import { prisma } from "../services/postgres.service";
import { authMiddleware } from "../middleware/auth.middleware";

/**
 * Sanitize a tool name for AI function calling (snake_case, no special chars).
 */
function sanitizeToolName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
}

export const toolController = new Elysia({ prefix: "/tools" })
    .use(authMiddleware)
    .guard({ isSignIn: true })

    // List tools by bot
    .get("/", async ({ query }) => {
        const { botId } = query as any;
        if (!botId) return [];
        return prisma.tool.findMany({
            where: { botId },
            orderBy: { createdAt: "desc" },
        });
    })

    // Get single tool
    .get("/:id", async ({ params: { id }, set }) => {
        const tool = await prisma.tool.findUnique({ where: { id } });
        if (!tool) {
            set.status = 404;
            return { error: "Tool not found" };
        }
        return tool;
    })

    // Create tool
    .post("/", async ({ body, set }) => {
        const { botId, name, description, parameters, actionType, actionConfig, flowId } = body as any;

        if (!botId || !name || !description || !actionType) {
            set.status = 400;
            return { error: "botId, name, description, and actionType are required" };
        }

        const sanitizedName = sanitizeToolName(name);

        try {
            const tool = await prisma.tool.create({
                data: {
                    botId,
                    name: sanitizedName,
                    description,
                    parameters: parameters || { type: "object", properties: {} },
                    actionType,
                    actionConfig: actionConfig || {},
                    flowId: flowId || undefined,
                },
            });
            return tool;
        } catch (e: any) {
            if (e.code === "P2002") {
                set.status = 409;
                return { error: `Tool name '${sanitizedName}' already exists for this bot` };
            }
            throw e;
        }
    })

    // Update tool
    .put("/:id", async ({ params: { id }, body, set }) => {
        const { name, description, parameters, actionType, actionConfig, status, flowId } = body as any;

        try {
            const data: any = {};
            if (name !== undefined) data.name = sanitizeToolName(name);
            if (description !== undefined) data.description = description;
            if (parameters !== undefined) data.parameters = parameters;
            if (actionType !== undefined) data.actionType = actionType;
            if (actionConfig !== undefined) data.actionConfig = actionConfig;
            if (status !== undefined) data.status = status;
            if (flowId !== undefined) data.flowId = flowId || null;

            const tool = await prisma.tool.update({ where: { id }, data });
            return tool;
        } catch (e: any) {
            set.status = 500;
            return { error: "Failed to update tool" };
        }
    })

    // Delete tool
    .delete("/:id", async ({ params: { id }, set }) => {
        try {
            await prisma.tool.delete({ where: { id } });
            return { success: true };
        } catch (e: any) {
            set.status = 500;
            return { error: "Failed to delete tool" };
        }
    })

    // Migrate flow to tool
    .post("/from-flow/:flowId", async ({ params: { flowId }, set }) => {
        const flow = await prisma.flow.findUnique({
            where: { id: flowId },
            include: { steps: true },
        });

        if (!flow) {
            set.status = 404;
            return { error: "Flow not found" };
        }

        const sanitizedName = sanitizeToolName(flow.name);

        try {
            const tool = await prisma.tool.create({
                data: {
                    botId: flow.botId,
                    name: sanitizedName,
                    description: flow.description || `Executes the '${flow.name}' flow sequence.`,
                    parameters: { type: "object", properties: {} },
                    actionType: "FLOW",
                    actionConfig: { flowId: flow.id },
                    flowId: flow.id,
                },
            });
            return tool;
        } catch (e: any) {
            if (e.code === "P2002") {
                set.status = 409;
                return { error: `Tool '${sanitizedName}' already exists for this bot` };
            }
            throw e;
        }
    });
