import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {PrismaClient, type WorkspaceRole} from "@prisma/client";
import {randomUUID} from "node:crypto";

const testDatabaseUrl = process.env.DATABASE_URL_TEST;

function assertSafeTestDatabase(url: string) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Tenant integration tests are forbidden in NODE_ENV=production.");
  }

  const parsed = new URL(url);
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(
      `Refusing to run integration tests against non-local database host "${parsed.hostname}". Use a disposable local PostgreSQL database.`,
    );
  }

  if (url === process.env.DATABASE_URL || url === process.env.DIRECT_URL) {
    throw new Error("DATABASE_URL_TEST must not match the application's configured database URL.");
  }
}

if (testDatabaseUrl) assertSafeTestDatabase(testDatabaseUrl);

const integration = describe.skipIf(!testDatabaseUrl);
integration("PostgreSQL tenant isolation constraints", () => {
  const prisma = new PrismaClient({
    datasources: {db: {url: testDatabaseUrl!}},
  });

  const suffix = randomUUID();
  let workspaceA: {id: string};
  let workspaceB: {id: string};
  let userA: {id: string};
  let userB: {id: string};
  let brandA: {id: string};
  let brandB: {id: string};\n  let websiteA: {id: string};\n  let websiteB: {id: string};

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      prisma.workspace.create({
        data: {name: `Tenant A ${suffix}`, slug: `tenant-a-${suffix}`},
        select: {id: true},
      }),
      prisma.workspace.create({
        data: {name: `Tenant B ${suffix}`, slug: `tenant-b-${suffix}`},
        select: {id: true},
      }),
    ]);
    workspaceA = a;
    workspaceB = b;

    const [ua, ub] = await Promise.all([
      prisma.user.create({
        data: {email: `tenant-a-${suffix}@example.test`, passwordHash: "integration-test-hash"},
        select: {id: true},
      }),
      prisma.user.create({
        data: {email: `tenant-b-${suffix}@example.test`, passwordHash: "integration-test-hash"},
        select: {id: true},
      }),
    ]);
    userA = ua;
    userB = ub;

    await prisma.workspaceMembership.createMany({
      data: [
        {workspaceId: workspaceA.id, userId: userA.id, role: "OWNER" satisfies WorkspaceRole},
        {workspaceId: workspaceB.id, userId: userB.id, role: "OWNER" satisfies WorkspaceRole},
      ],
    });

    const [ba, bb] = await Promise.all([
      prisma.brand.create({
        data: {workspaceId: workspaceA.id, name: `Brand A ${suffix}`},
        select: {id: true},
      }),
      prisma.brand.create({
        data: {workspaceId: workspaceB.id, name: `Brand B ${suffix}`},
        select: {id: true},
      }),
    ]);
    brandA = ba;
    brandB = bb;\n\n    const [wa, wb] = await Promise.all([\n      prisma.website.create({data: {workspaceId: workspaceA.id, name: "Tenant A site", domain: "tenant-a.example.test", trackingId: "site_" + suffix.replace(/-/g, "").slice(0, 24)}, select: {id: true}}),\n      prisma.website.create({data: {workspaceId: workspaceB.id, name: "Tenant B site", domain: "tenant-b.example.test", trackingId: "site_" + randomUUID().replace(/-/g, "").slice(0, 24)}, select: {id: true}}),\n    ]);\n    websiteA = wa;\n    websiteB = wb;
  }, 30_000);

  afterAll(async () => {
    // Workspace and user relations cascade; delete only this suite's fixtures.
    if (workspaceA?.id) await prisma.workspace.deleteMany({where: {id: workspaceA.id}});
    if (workspaceB?.id) await prisma.workspace.deleteMany({where: {id: workspaceB.id}});
    if (userA?.id) await prisma.user.deleteMany({where: {id: userA.id}});
    if (userB?.id) await prisma.user.deleteMany({where: {id: userB.id}});
    await prisma.$disconnect();
  }, 30_000);

  it("returns only records owned by the selected workspace", async () => {
    const [brandsA, brandsB] = await Promise.all([
      prisma.brand.findMany({where: {workspaceId: workspaceA.id}, select: {id: true}}),
      prisma.brand.findMany({where: {workspaceId: workspaceB.id}, select: {id: true}}),
    ]);

    expect(brandsA.map((brand) => brand.id)).toEqual([brandA.id]);
    expect(brandsB.map((brand) => brand.id)).toEqual([brandB.id]);
    expect(brandsA.some((brand) => brand.id === brandB.id)).toBe(false);
  });

  it("rejects a social account whose brand belongs to another workspace", async () => {
    await expect(
      prisma.socialAccount.create({
        data: {
          workspaceId: workspaceA.id,
          brandId: brandB.id,
          provider: "INSTAGRAM",
          accountName: "cross-tenant-attempt",
        },
      }),
    ).rejects.toMatchObject({code: "P2003"});
  });

  it("rejects a content post whose brand belongs to another workspace", async () => {
    await expect(
      prisma.contentPost.create({
        data: {
          workspaceId: workspaceA.id,
          brandId: brandB.id,
          body: "Cross-tenant integrity test",
        },
      }),
    ).rejects.toMatchObject({code: "P2003"});
  });

  it("rejects a campaign whose optional brand belongs to another workspace", async () => {
    await expect(
      prisma.campaign.create({
        data: {
          workspaceId: workspaceA.id,
          brandId: brandB.id,
          name: "Cross-tenant campaign test",
        },
      }),
    ).rejects.toMatchObject({code: "P2003"});
  });
});
