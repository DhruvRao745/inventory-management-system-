/**
 * ONE shared database connection for the whole app.
 *
 * Simple picture: PrismaClient is like a phone line to Postgres.
 * You don't want every file dialing its own new line — you'd run
 * out of lines. So we dial once, here, and everyone shares it.
 */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
