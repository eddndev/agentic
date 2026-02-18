import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
    const email = process.env.SUPER_ADMIN_EMAIL || "admin@agentic.com";
    const password = process.env.SUPER_ADMIN_PASSWORD || "password123";

    if (!process.env.SUPER_ADMIN_EMAIL || !process.env.SUPER_ADMIN_PASSWORD) {
        console.warn("Warning: Using default credentials for Admin. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env for production.");
    }

    const existingUser = await prisma.user.findUnique({
        where: { email }
    });

    if (existingUser) {
        console.log(`User ${email} already exists.`);
        return;
    }

    const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 3
    });

    const user = await prisma.user.create({
        data: {
            email,
            passwordHash,
            fullName: "Admin",
            isActive: true
        }
    });

    console.log(`Created Admin: ${user.email} / ${password}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
