import { Elysia, t } from "elysia";
import { prisma } from "../services/postgres.service";
import { MatchType } from "@prisma/client";
import { authMiddleware } from "../middleware/auth.middleware";

export const triggerController = new Elysia({ prefix: "/triggers" })
    .use(authMiddleware)
    .guard({ isSignIn: true })
    .get("/", async ({ query }) => {
        const { botId, flowId } = query as { botId?: string, flowId?: string };

        return prisma.trigger.findMany({
            where: {
                botId: botId || undefined,
                flowId: flowId || undefined
            },
            include: { flow: true },
            orderBy: { createdAt: "desc" }
        });
    })
    .get("/:id", async ({ params: { id }, set }) => {
        const trigger = await prisma.trigger.findUnique({
            where: { id }
        });
        if (!trigger) {
            set.status = 404;
            return "Trigger not found";
        }
        return trigger;
    })
    .post("/", async ({ body, set }) => {
        const { botId, flowId, keyword, matchType, isActive, scope } = body as any;

        if (!flowId) {
            set.status = 400;
            return "flowId is required";
        }

        try {
            const trigger = await prisma.trigger.create({
                data: {
                    botId,
                    keyword,
                    matchType: (matchType as MatchType) || MatchType.CONTAINS,
                    scope: (scope as any) || "INCOMING",
                    isActive: isActive ?? true,
                    flowId,
                }
            });
            return trigger;
        } catch (e: any) {
            set.status = 500;
            return `Failed to create trigger: ${e.message}`;
        }
    }, {
        body: t.Object({
            botId: t.String(),
            keyword: t.String(),
            flowId: t.String(),
            matchType: t.Optional(t.String()),
            scope: t.Optional(t.String()),
            isActive: t.Optional(t.Boolean()),
        })
    })
    .put("/:id", async ({ params: { id }, body, set }) => {
        const { keyword, matchType, isActive, flowId, scope } = body as any;

        try {
            const trigger = await prisma.trigger.update({
                where: { id },
                data: {
                    keyword,
                    matchType: matchType as MatchType,
                    scope: scope as any,
                    isActive,
                    flowId: flowId ?? undefined,
                }
            });
            return trigger;
        } catch (e: any) {
            set.status = 500;
            return "Failed to update trigger";
        }
    })
    .delete("/:id", async ({ params: { id }, set }) => {
        try {
            await prisma.trigger.delete({
                where: { id }
            });
            return { success: true };
        } catch (e) {
            set.status = 500;
            return "Failed to delete trigger";
        }
    });
