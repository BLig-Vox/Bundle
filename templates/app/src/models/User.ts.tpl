import { EntitySchema } from "@mikro-orm/core";

export class User { id!: number; email!: string; passwordHash!: string; }
export default new EntitySchema<User>({ class: User, tableName: "users", properties: {
  id: { type: "number", primary: true },
  email: { type: "string", length: 254, unique: true },
  passwordHash: { type: "text", hidden: true },
} });
