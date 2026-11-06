import { EntitySchema, ReferenceKind, OptionalProps } from "@mikro-orm/core";
import { User } from "./User.ts";

export class Post {
  [OptionalProps]?: "createdAt" | "updatedAt";
  id!: number;
  title!: string;
  slug!: string;
  body!: string;
  author!: User;
  createdAt = new Date();
  updatedAt = new Date();
}

export default new EntitySchema<Post>({
  class: Post,
  tableName: "posts",
  properties: {
    id: { type: "number", primary: true },
    title: { type: "string", length: 200 },
    slug: { type: "string", length: 200, unique: true },
    body: { type: "text" },
    author: { kind: ReferenceKind.MANY_TO_ONE, entity: () => User, inversedBy: "posts", deleteRule: "cascade" },
    createdAt: { type: Date },
    updatedAt: { type: Date, onUpdate: () => new Date() },
  },
});
