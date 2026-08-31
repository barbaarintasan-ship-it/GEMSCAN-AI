// A role that joins ROLES_NOT_SCORED with no matching notScoredWhy translation
// renders as the raw i18n key ("field.coverage.notScoredWhy.lineaments") in the
// evidence panel instead of the reason a geologist is owed — exactly what
// happened when `lineaments` shipped without one in either locale. This pins
// the fix and catches the same class of bug the next time a role joins the list.
import en from "../../locales/en.json";
import so from "../../locales/so.json";
import { ROLES_NOT_SCORED } from "../geo/evidenceRoles";

describe("every withheld role has a stated reason, in both languages", () => {
  for (const role of ROLES_NOT_SCORED) {
    test(role, () => {
      const enText = (en as any).field.coverage.notScoredWhy[role];
      const soText = (so as any).field.coverage.notScoredWhy[role];
      expect(typeof enText).toBe("string");
      expect(enText.length).toBeGreaterThan(0);
      expect(typeof soText).toBe("string");
      expect(soText.length).toBeGreaterThan(0);
    });
  }
});
