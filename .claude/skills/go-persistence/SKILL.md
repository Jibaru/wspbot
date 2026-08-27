---
name: go-persistence
description: Persistence is the ability of a system to maintain its state across restarts. In golang, there are several ways to achieve persistence, such as using databases, file systems, or in-memory data structures. This skill will cover the basics of persistence in golang, including how to use different storage options and best practices for maintaining data integrity and performance.
---

# Persistence in golang

## TRIGGERS

1. If the application needs to store data that should persist across restarts.
2. If the application needs to maintain state or user sessions.
3. If the application needs to connect to a database or external storage system.

## WHAT IT DOES

- Provides a way to store and retrieve data in golang applications.
- Provides patterns and best practices to connect to databases and manage data integrity.
- Helps separating concerns by abstracting the persistence layer from the business logic.
- Provide examples of how to use different storage options, such as SQL databases, NoSQL databases, file systems, and in-memory data structures.
- Provide examples of how to populate information, avoid common pitfalls, and optimize performance when working with persistence in golang.

## INSTRUCTIONS

1. Choose the appropriate storage option for your application (e.g., SQL database, NoSQL database, file system, in-memory data structure).
2. Use the appropriate libraries and drivers to connect to the chosen storage option (e.g., database/sql for SQL databases, mgo for MongoDB, os package for file systems).
3. Implement the necessary functions to read and write data to the storage option.
4. Use best practices for maintaining data integrity and performance, such as using transactions, indexing, and caching.
5. Test the persistence layer to ensure that it is working correctly and efficiently.

## RULES

- Use repository pattern to abstract the persistence layer from the business logic. The pattern could use: functions or interfaces.
Use functions only when persistence is simple and does not require complex interactions with the data. Use interfaces when persistence requires more complex interactions, such as multiple storage options or complex queries. All interfaces MUST live in the domain package or in the business logic layer, never in the infrastructure layer. The implementation of the interfaces MUST live in the infrastructure layer.
- Always handle errors when working with persistence, and log them appropriately.
- Errors from repository layer MUST exists in domain or business logic layer, never in the infrastructure layer. The infrastructure layer should return domain errors, never infrastructure errors.
- Use transactions when working with databases to ensure data integrity.
- Use indexing to optimize query performance when working with databases.
- To work with migrations, use goose to manage database schema changes. Migrations should be stored in a separate folder, such as "migrations", and should be organized.
- When working with file systems, ensure that the application has the necessary permissions to read and write to the files, and handle file locking if necessary.
- The package structure MUST follow:

```
users // module name 
  |-- infra
     |-- persistence
        |-- <implementation>
            |-- users.go // repository or functions to manage users in the chosen implementation, e.g. mongo, postgres, json, etc.
  |-- domain
      |-- user.go // domain models
      |-- user_repo.go // repository interfaces, also can contain errors that MUST be returned in implementation.
```
- For IDs, they MUST be created in the domain layer, and passed to the repository layer for storage. The repository layer should not generate IDs, as this is a responsibility of the domain layer. If the repository layer wants to create and ID, use a new function or methods called `NextID() <ID_TYPE>` in the repository interface, and implement it in the infrastructure layer. This way, the domain layer can call the `NextID()` method to generate a new ID when needed, while still keeping the responsibility of ID generation in the domain layer. The ID implementation could be a UUID or NanoID.

## CHANGE CONDITIONS

- Ask always to the user if they need specific changes to the implementation, such as specific storage options, or specific use cases.

## EXAMPLES

1. Simple file data storage.

Uses functions to read and write data to a file using the os package. Mainly store data in JSON format.

**IMPORTANT**: Read the example if needed.

[FILE-STORAGE-EXAMPLE](examples/1-file.md)

2. Mongo database storage.

Uses the mongo driver package to connect to a Mongo database and perform CRUD operations.

**IMPORTANT**: Read the example if needed.

[MONGO-DB-EXAMPLE](examples/2-mongo-db.md)

3. Postgres database storage.

Uses the pgx driver package to connect to a Postgres database and perform CRUD operations.

**IMPORTANT**: Read the example if needed.

[POSTGRES-DB-EXAMPLE](examples/3-postgres-db.md)


## PRO TIPS

- When working with databases, use connection pooling to optimize performance and resource usage.
- Use prepared statements to prevent SQL injection attacks when working with SQL databases.
- Use context to manage timeouts and cancellations when working with databases and external storage systems.

## PATTERNS

### Repository

The repository pattern is a design pattern that abstracts the persistence layer from the business logic. It provides a way to manage data access and storage without exposing the underlying implementation details. The repository can be implemented using functions or interfaces, depending on the complexity of the persistence needs.

### Data Mapper

The data mapper pattern is a design pattern that separates the in-memory objects from the database schema. It provides a way to map between the two, allowing for more flexibility and separation of concerns. This pattern is often used in conjunction with the repository pattern to manage data access and storage.
It can be only simple functions that map between domain models and database models, or it can be a more complex layer that handles the mapping and also the interactions with the database.

### ORM

The object-relational mapping (ORM) pattern is a design pattern that provides a way to map between object-oriented programming languages and relational databases. It allows developers to work with databases using objects and classes, rather than writing raw SQL queries. This can simplify development and improve productivity, but it can also introduce performance overhead and complexity.

You can you **gorm** as an ORM in golang, but be careful when using it, as it can introduce performance issues if not used correctly. Ask the user if they want to use an ORM, and if so, provide examples of how to use it correctly to avoid performance issues.

### Criteria/Specification/Query Object

The criteria/specification/query object pattern is a design pattern that provides a way to encapsulate query logic and criteria in a separate object. This allows for more flexibility and separation of concerns when working with databases and external storage systems. It can be used in conjunction with the repository pattern to manage data access and storage. The criteria/specification/query object can be implemented as a struct that contains the necessary fields and methods to build and execute queries against the database or external storage system.

### SPECIAL CASES

- When working with complex queries, consider using a SQL inside a method in the repository or function instead of using criteria. This can simplify the implementation and improve performance, as it allows you to write optimized SQL queries directly against the database.

### TESTS

- Add integration tests to ensure that the persistence layer is working correctly and efficiently. These tests should cover all CRUD operations and any complex interactions with the database or external storage system. Ask the user if they want to include tests in the implementation, and if so, provide examples of how to write integration tests for the persistence layer.
- For testing use testify `github.com/stretchr/testify/assert` and for mocks, if needed, use `mockery` in version 3.

# USE CASES

1. An e-commerce application that needs to store user information, product details, and order history in a database.
2. A social media application that needs to maintain user sessions and store user-generated content in a database.
3. A content management system that needs to store articles, images, and other media files in a file system or cloud storage service.
4. A real-time chat application that needs to maintain user sessions and store chat history in a database or in-memory data structure.
5. A financial application that needs to store transaction history and account information in a database, while ensuring data integrity and security.
6. Whatever application that needs to maintain state across restarts, such as an API server, can benefit from implementing persistence in golang to store user progress and data.
