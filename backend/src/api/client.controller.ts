import type { Context } from "elysia";
import { prisma } from "../services/postgres.service";

/**
 * Controller for Client management
 */
export const ClientController = {
    /**
     * Get all clients
     */
    getAll: async ({ query }: Context) => {
        const filters: any = {};
        const q = query as any;

        if (q && q.botId) {
            filters.botId = q.botId;
        }

        const clients = await prisma.client.findMany({
            where: filters,
            orderBy: { createdAt: 'desc' },
            take: 100
        });

        return clients.map(c => {
            const { encryptedPassword, ...rest } = c;
            return rest;
        });
    },

    /**
     * Get single client by ID
     */
    getOne: async ({ params: { id } }: Context) => {
        const client = await prisma.client.findUnique({
            where: { id: id as string }
        });

        if (!client) {
            return new Response("Client not found", { status: 404 });
        }

        const { encryptedPassword, ...rest } = client;
        return rest;
    },

    /**
     * Create new client
     */
    create: async ({ body }: Context) => {
        const data = body as any;

        if (!data.email || !data.phoneNumber || !data.name || !data.botId) {
            return new Response("Missing required fields: email, phoneNumber, name, botId", { status: 400 });
        }

        try {
            const bot = await prisma.bot.findUnique({ where: { id: data.botId } });
            if (!bot) {
                return new Response("Bot not found", { status: 404 });
            }

            const newClient = await prisma.client.create({
                data: {
                    email: data.email,
                    phoneNumber: data.phoneNumber,
                    name: data.name,
                    curp: data.curp || null,
                    status: data.status || undefined,
                    botId: data.botId,
                }
            });

            const { encryptedPassword: _, ...rest } = newClient;
            return rest;

        } catch (error: any) {
            if (error.code === 'P2002') {
                const field = error.meta?.target?.[0] || 'email';
                return new Response(`Client with this ${field} already exists`, { status: 409 });
            }
            console.error("Error creating client:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    },

    /**
     * Update client
     */
    update: async ({ params: { id }, body }: Context) => {
        const data = body as any;

        try {
            const { plainTextPassword, botId, ...updateData } = data;

            const updated = await prisma.client.update({
                where: { id: id as string },
                data: updateData
            });

            const { encryptedPassword, ...rest } = updated;
            return rest;
        } catch (error) {
            console.error("Error updating client:", error);
            return new Response("Error updating client", { status: 500 });
        }
    },

    /**
     * Delete client
     */
    delete: async ({ params: { id } }: Context) => {
        await prisma.client.delete({
            where: { id: id as string }
        });
        return { success: true };
    }
};
