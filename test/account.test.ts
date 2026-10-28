import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { AccountService } from "../src/gen/toshi/workspace/v1/account_pb.js";
import { createFake } from "../src/test/index.js";

describe("the caller's account", () => {
  it("reads the account, its identities and an unlink through the client", async () => {
    const fake = createFake();
    fake.on(AccountService.method.getAccount, () =>
      Promise.resolve({
        account: { userId: "user-1", name: "Ada", email: "ada@example.com" },
        identities: [{ provider: "github", subject: "1", login: "ada", lastSignInAt: timestampFromDate(new Date()) }],
        workspaces: ["default", "zeta"],
      }),
    );
    fake.on(AccountService.method.listIdentities, () =>
      Promise.resolve({
        identities: [
          { provider: "github", subject: "1", login: "ada" },
          { provider: "https://issuer.example.com", subject: "2", login: "ada@example.com" },
        ],
      }),
    );
    fake.on(AccountService.method.unlinkIdentity, (request) => {
      expect(request.provider).toBe("github");
      expect(request.subject).toBe("1");
      return Promise.resolve({ identity: { provider: "github", subject: "1", login: "ada" }, sessionsEnded: 2, grantsRevoked: 1 });
    });

    const toshi = fake.client();
    const account = await toshi.account.getAccount({});
    expect(account.account?.userId).toBe("user-1");
    expect(account.account?.email).toBe("ada@example.com");
    expect(account.identities.map((identity) => identity.login)).toEqual(["ada"]);
    expect(account.workspaces).toEqual(["default", "zeta"]);

    const identities = await toshi.account.listIdentities({});
    expect(identities.identities).toHaveLength(2);
    expect(identities.identities[1].provider).toBe("https://issuer.example.com");

    const unlinked = await toshi.account.unlinkIdentity({ provider: "github", subject: "1" });
    expect(unlinked.identity?.login).toBe("ada");
    expect(unlinked.sessionsEnded).toBe(2);
    expect(unlinked.grantsRevoked).toBe(1);
  });
});
