import { Migration } from "@mikro-orm/migrations";

export class Migration20261106000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('create table `users` (`id` int unsigned not null auto_increment primary key, `name` varchar(120) not null, `email` varchar(254) not null, `created_at` datetime not null, `updated_at` datetime not null) default character set utf8mb4 engine = InnoDB;');
    this.addSql('alter table `users` add unique `users_email_unique` (`email`);');
    this.addSql('create table `posts` (`id` int unsigned not null auto_increment primary key, `title` varchar(200) not null, `slug` varchar(200) not null, `body` text not null, `author_id` int unsigned not null, `created_at` datetime not null, `updated_at` datetime not null) default character set utf8mb4 engine = InnoDB;');
    this.addSql('alter table `posts` add unique `posts_slug_unique` (`slug`);');
    this.addSql('alter table `posts` add index `posts_author_id_index` (`author_id`);');
    this.addSql('alter table `posts` add constraint `posts_author_id_foreign` foreign key (`author_id`) references `users` (`id`) on delete cascade;');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists `posts`;');
    this.addSql('drop table if exists `users`;');
  }
}
