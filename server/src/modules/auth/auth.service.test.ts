/**
 * Auth service tests — registration, login, and the security details.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as authService from "./auth.service.js";
import { resetDb } from "../../test/helpers.js";

async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

const input = {
  companyName: "Rao Traders",
  name: "Mr. Rao",
  email: "rao@test.com",
  password: "secret123",
};

describe("auth service", () => {
  beforeEach(resetDb);

  it("register creates company + admin + default location together", async () => {
    const result = await authService.register(input);

    expect(result.token).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.user.role).toBe("ADMIN");

    const locations = await prisma.location.findMany({
      where: { companyId: result.company.id },
    });
    expect(locations).toHaveLength(1);
    expect(locations[0].isDefault).toBe(true);

    // the password itself must be nowhere in the database
    const dbUser = await prisma.user.findFirst();
    expect(dbUser!.passwordHash).not.toBe(input.password);
    expect(dbUser!.passwordHash).not.toContain("secret");
  });

  it("login works with correct password", async () => {
    await authService.register(input);
    const result = await authService.login({
      email: input.email,
      password: input.password,
    });
    expect(result.user.email).toBe(input.email);
  });

  it("wrong password and unknown email fail with the SAME message", async () => {
    await authService.register(input);

    const wrongPassword = await expectAppError(
      authService.login({ email: input.email, password: "wrong-password" }),
      401
    );
    const unknownEmail = await expectAppError(
      authService.login({ email: "ghost@test.com", password: "whatever" }),
      401
    );
    // identical messages = attackers can't fish for valid emails
    expect(wrongPassword.message).toBe(unknownEmail.message);
  });

  it("duplicate email registration is rejected", async () => {
    await authService.register(input);
    await expectAppError(
      authService.register({ ...input, companyName: "Another Co" }),
      409
    );
  });

  it("deactivated users cannot login or refresh", async () => {
    const result = await authService.register(input);
    await prisma.user.update({
      where: { id: result.user.id },
      data: { isActive: false },
    });

    await expectAppError(
      authService.login({ email: input.email, password: input.password }),
      401
    );
    // even a still-valid renewal card is refused once the account is off
    await expectAppError(authService.refresh(result.refreshToken), 401);
  });
});
