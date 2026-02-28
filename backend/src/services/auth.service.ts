import { prisma } from "./postgres.service";
import { User } from "@prisma/client";
import argon2 from "argon2";

export class AuthService {
    /**
     * Authenticate user with email and password
     */
    static async validateUser(email: string, passwordPlain: string): Promise<User | null> {
        const user = await prisma.user.findUnique({
            where: { email }
        });

        if (!user || !user.isActive) return null;

        const isValid = await argon2.verify(user.passwordHash, passwordPlain);
        if (!isValid) return null;

        return user;
    }

    /**
     * Create a new user (Internal/Seed use mostly)
     */
    static async createUser(email: string, passwordPlain: string, fullName?: string): Promise<User> {
        const passwordHash = await argon2.hash(passwordPlain, {
            type: argon2.argon2id,
            memoryCost: 4096,
            timeCost: 3
        });

        return prisma.user.create({
            data: {
                email,
                passwordHash,
                fullName,
                isActive: true
            }
        });
    }

    /**
     * Get user by ID (for generic lookups usually)
     */
    static async getUserById(id: string): Promise<Omit<User, 'passwordHash'> | null> {
        const user = await prisma.user.findUnique({ where: { id } });
        if (!user) return null;
        const { passwordHash, ...safeUser } = user;
        return safeUser;
    }
}
