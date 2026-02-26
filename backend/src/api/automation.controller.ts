import { Elysia } from "elysia";
import { prisma } from "../services/postgres.service";
import { authMiddleware } from "../middleware/auth.middleware";

export const automationController = new Elysia({ prefix: "/bots" })
    .use(authMiddleware)
    .guard({ isSignIn: true })

    // List automations for a bot
    .get("/:id/automations", async ({ params: { id } }) => {
        return prisma.automation.findMany({
            where: { botId: id },
            orderBy: { createdAt: "desc" },
        });
    })

    // Create automation
    .post("/:id/automations", async ({ params: { id }, body, set }) => {
        const { name, description, enabled, event, labelName, timeoutMs, prompt } = body as any;

        if (!name || !event || !timeoutMs || !prompt) {
            set.status = 400;
            return { error: "name, event, timeoutMs, and prompt are required" };
        }

        return prisma.automation.create({
            data: {
                botId: id,
                name,
                description: description || null,
                enabled: enabled ?? true,
                event,
                labelName,
                timeoutMs,
                prompt,
            },
        });
    })

    // Update automation
    .put("/:id/automations/:automationId", async ({ params: { automationId }, body, set }) => {
        const { name, description, enabled, event, labelName, timeoutMs, prompt } = body as any;

        const data: any = {};
        if (name !== undefined) data.name = name;
        if (description !== undefined) data.description = description;
        if (enabled !== undefined) data.enabled = enabled;
        if (event !== undefined) data.event = event;
        if (labelName !== undefined) data.labelName = labelName;
        if (timeoutMs !== undefined) data.timeoutMs = timeoutMs;
        if (prompt !== undefined) data.prompt = prompt;

        try {
            return await prisma.automation.update({ where: { id: automationId }, data });
        } catch (e: any) {
            set.status = 404;
            return { error: "Automation not found" };
        }
    })

    // Delete automation
    .delete("/:id/automations/:automationId", async ({ params: { automationId }, set }) => {
        try {
            await prisma.automation.delete({ where: { id: automationId } });
            return { success: true };
        } catch (e: any) {
            set.status = 404;
            return { error: "Automation not found" };
        }
    });
