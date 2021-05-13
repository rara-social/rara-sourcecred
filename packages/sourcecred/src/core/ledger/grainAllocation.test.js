// @flow

import {random as randomUuid, parser as uuidParser} from "../../util/uuid";
import {
  computeAllocation,
  type AllocationIdentity,
  _validateAllocationBudget,
} from "./grainAllocation";
import {fromString as nngFromString} from "./nonnegativeGrain";
import {toDiscount} from "./policies/recent";

describe("core/ledger/grainAllocation", () => {
  // concise helper for grain from a number
  const nng = (x: number) => nngFromString(x.toString());
  // concise helper for an allocation identity
  function aid(paid: number, cred: $ReadOnlyArray<number>): AllocationIdentity {
    return {id: randomUuid(), paid: nng(paid), cred};
  }
  const immediate = (n: number) => ({
    policyType: "IMMEDIATE",
    budget: nng(n),
    numIntervalsLookback: 1,
  });
  const recent = (n: number, discount: number) => ({
    policyType: "RECENT",
    budget: nng(n),
    discount: toDiscount(discount),
  });
  const balanced = (n: number) => ({policyType: "BALANCED", budget: nng(n)});

  describe("computeAllocation", () => {
    describe("validation", () => {
      it("errors if there are no identities", () => {
        const thunk = () => computeAllocation(immediate(5), []);
        expect(thunk).toThrowError("must have at least one identity");
      });
      it("errors if the total cred is zero", () => {
        const thunk = () => computeAllocation(immediate(5), [aid(0, [0])]);
        expect(thunk).toThrowError("cred is zero");
      });
      it("errors if there's NaN or Infinity in Cred", () => {
        const thunk = () => computeAllocation(immediate(5), [aid(0, [NaN])]);
        expect(thunk).toThrowError("invalid cred");
      });
      it("errors if there's inconsistent Cred lengths", () => {
        const i1 = aid(0, [1]);
        const i2 = aid(0, [1, 2]);
        const thunk = () => computeAllocation(immediate(5), [i1, i2]);
        expect(thunk).toThrowError("inconsistent cred length");
      });
      it("errors if the receipts don't match the budget", () => {
        const badAllocation = {
          policy: immediate(5),
          id: randomUuid(),
          receipts: [],
        };
        const thunk = () => _validateAllocationBudget(badAllocation);
        expect(thunk).toThrow("has budget of 5 but distributed 0");
      });
    });

    describe("immediate policy", () => {
      it("splits based on just most recent cred", () => {
        const policy = immediate(10);
        const i1 = aid(100, [10, 2]);
        const i2 = aid(0, [0, 3]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(4)},
          {id: i2.id, amount: nng(6)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
      it("handles 0 budget correctly", () => {
        const policy = immediate(0);
        const i1 = aid(3, [1, 1]);
        const i2 = aid(0, [3, 0]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(0)},
          {id: i2.id, amount: nng(0)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
    });

    describe("recent policy", () => {
      it("splits based on discounted cred", () => {
        const policy = recent(100, 0.1);
        const i1 = aid(0, [0, 0, 100]);
        const i2 = aid(100, [100, 0, 0]);
        const i3 = aid(0, [100, 0, 0]);
        const allocation = computeAllocation(policy, [i1, i2, i3]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(38)},
          {id: i2.id, amount: nng(31)},
          {id: i3.id, amount: nng(31)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });

      it("is not influenced by grain paid", () => {
        const policy = recent(100, 0.1);
        const i1 = aid(0, [100, 100, 100]);
        const i2 = aid(100, [100, 100, 100]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(50)},
          {id: i2.id, amount: nng(50)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });

      it("handles full discount correctly", () => {
        const policy = recent(100, 1);
        const i1 = aid(50, [0, 50, 0]);
        const i2 = aid(0, [0, 10, 100]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(0)},
          {id: i2.id, amount: nng(100)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });

      it("handles 0 budget correctly", () => {
        const policy = recent(0, 0.1);
        const i1 = aid(50, [100, 50, 10]);
        const i2 = aid(0, [0, 10, 100]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(0)},
          {id: i2.id, amount: nng(0)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
    });

    describe("balanced policy", () => {
      it("splits based on lifetime Cred when there's no paid amounts", () => {
        const policy = balanced(100);
        const i1 = aid(0, [1, 1]);
        const i2 = aid(0, [3, 0]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(40)},
          {id: i2.id, amount: nng(60)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
      it("takes past payment into account", () => {
        const policy = balanced(20);
        const i1 = aid(0, [1, 1]);
        const i2 = aid(30, [3, 0]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(20)},
          {id: i2.id, amount: nng(0)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
      it("handles 0 budget correctly", () => {
        const policy = balanced(0);
        const i1 = aid(30, [1, 1]);
        const i2 = aid(0, [3, 0]);
        const allocation = computeAllocation(policy, [i1, i2]);
        const expectedReceipts = [
          {id: i1.id, amount: nng(0)},
          {id: i2.id, amount: nng(0)},
        ];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
    });

    describe("special policy", () => {
      it("distributes the budget to the stated recipient", () => {
        const i1 = aid(0, [1]);
        const policy = {
          policyType: "SPECIAL",
          budget: nng(100),
          memo: "something",
          recipient: i1.id,
        };
        const allocation = computeAllocation(policy, [i1]);
        const expectedReceipts = [{id: i1.id, amount: nng(100)}];
        const expectedAllocation = {
          receipts: expectedReceipts,
          id: uuidParser.parseOrThrow(allocation.id),
          policy,
        };
        expect(allocation).toEqual(expectedAllocation);
      });
      it("errors if the recipient is not available", () => {
        const {id} = aid(0, [1]);
        const other = aid(0, [1]);
        const policy = {
          policyType: "SPECIAL",
          budget: nng(100),
          memo: "something",
          recipient: id,
        };
        const thunk = () => computeAllocation(policy, [other]);
        expect(thunk).toThrowError("no active grain account for identity");
      });
    });
  });
});
