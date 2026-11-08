import { EntitySchema, ReferenceKind } from "@mikro-orm/core";
import { User } from "./User.ts";

export class Note { id!: number; body!: string; owner!: User; }
export default new EntitySchema<Note>({ class: Note, tableName: "notes", properties: {
  owner: { kind: ReferenceKind.MANY_TO_ONE, entity: () => User, deleteRule: "cascade" },
  id: { type: "number", primary: true }, body: { type: "text" },
} });
