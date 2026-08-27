# Server Setup Examples

## Server Package Responsibilities

The server package should:
- Initialize HTTP router
- Register all routes
- Apply middleware
- Wire dependencies (repositories, services, handlers)
- Keep routing configuration centralized

---

## Example 1: Blog API Server (Layered Architecture)

```go
package server

import (
	"database/sql"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"blog0/config"
	"blog0/internal/infra/handlers"
	"blog0/internal/infra/middlewares"
	"blog0/internal/infra/persistence/postgres"
	infraServices "blog0/internal/infra/services"
	"blog0/internal/services"
)

func New(cfg config.Config, db *sql.DB) *gin.Engine {
	router := gin.Default()
	router.Use(middlewares.UseCORS())

	// Initialize external service configs
	googleOAuthConfig := &oauth2.Config{
		RedirectURL:  fmt.Sprintf("%s/api/v1/auth/google/callback", cfg.APIBaseURI),
		ClientID:     cfg.GoogleClientID,
		ClientSecret: cfg.GoogleClientSecret,
		Scopes: []string{
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		},
		Endpoint: google.Endpoint,
	}

	// Initialize DAOs (Data Access Objects)
	postDAO := postgres.NewPostDAO(db)
	userDAO := postgres.NewUserDAO(db)
	commentDAO := postgres.NewCommentDAO(db)
	postLikeDAO := postgres.NewPostLikeDAO(db)
	bookmarkDAO := postgres.NewBookmarkDAO(db)
	followDAO := postgres.NewFollowDAO(db)

	// Initialize infrastructure services
	postContentGenerator := infraServices.NewOpenAIGenerator(cfg.OpenAIApiKey, "gpt-4o")
	nextIDFunc := uuid.NewString
	triggerDev := infraServices.NewTriggerDev(cfg.TriggerSecretKey)
	eventBus := infraServices.NewTriggerDevEventBus(triggerDev)

	// Initialize application services (use cases)
	startOAuthServ := services.NewStartOAuth(googleOAuthConfig)
	finishOAuthServ := services.NewFinishOAuth(
		userDAO,
		googleOAuthConfig,
		infraServices.GoogleInfoExtractor,
		nextIDFunc,
		cfg,
	)
	listPostsServ := services.NewListPosts(postDAO, userDAO, postLikeDAO, commentDAO)
	getPostBySlugServ := services.NewGetPostBySlug(postDAO, userDAO, commentDAO, postLikeDAO)
	createCommentServ := services.NewCreateComment(postDAO, userDAO, commentDAO, nextIDFunc)
	toggleLikeServ := services.NewToggleLike(postDAO, postLikeDAO, nextIDFunc)
	bookmarkPostServ := services.NewBookmarkPost(postDAO, bookmarkDAO, nextIDFunc)
	unbookmarkPostServ := services.NewUnbookmarkPost(postDAO, bookmarkDAO)
	createPostServ := services.NewCreatePost(postDAO, nextIDFunc, postContentGenerator, eventBus)
	updatePostServ := services.NewUpdatePost(postDAO, postContentGenerator, eventBus)
	deletePostServ := services.NewDeletePost(postDAO)
	listMyPostsServ := services.NewListMyPosts(postDAO, userDAO)
	getAuthorInfoServ := services.NewGetAuthorInfo(userDAO, postDAO, postLikeDAO)
	followUserServ := services.NewFollowUser(userDAO, followDAO, nextIDFunc)
	unfollowUserServ := services.NewUnfollowUser(userDAO, followDAO)
	getProfileServ := services.NewGetProfile(
		userDAO,
		followDAO,
		bookmarkDAO,
		postLikeDAO,
		postDAO,
	)

	// Public API routes
	api := router.Group("/api/v1")
	{
		// Public authentication endpoints
		api.GET("/auth/google", handlers.StartOAuth(startOAuthServ))
		api.GET("/auth/google/callback", handlers.OAuthCallback(finishOAuthServ))

		// Public read endpoints
		api.GET("/posts", handlers.ListPosts(listPostsServ))
		api.GET("/posts/:slug", handlers.GetPostBySlug(getPostBySlugServ))
		api.GET("/users/:author_id", handlers.GetAuthorInfo(getAuthorInfoServ))

		// Protected endpoints (require authentication)
		api.Use(middlewares.HasAuthorization(cfg.JWTSecret))
		{
			// User-specific endpoints
			api.GET("/me/profile", handlers.GetProfile(getProfileServ))
			api.POST("/me/posts", handlers.CreatePost(createPostServ))
			api.PUT("/me/posts/:slug", handlers.UpdatePost(updatePostServ))
			api.DELETE("/me/posts/:slug", handlers.DeletePost(deletePostServ))
			api.GET("/me/posts", handlers.ListMyPosts(listMyPostsServ))

			// Post interactions
			api.POST("/posts/:slug/comments", handlers.CreateComment(createCommentServ))
			api.POST("/posts/:slug/likes", handlers.ToggleLike(toggleLikeServ))
			api.POST("/posts/:slug/bookmarks", handlers.BookmarkPost(bookmarkPostServ))
			api.DELETE("/posts/:slug/bookmarks", handlers.UnbookmarkPost(unbookmarkPostServ))

			// User interactions
			api.POST("/users/:author_id/follow", handlers.FollowUser(followUserServ))
			api.DELETE("/users/:author_id/follow", handlers.UnfollowUser(unfollowUserServ))
		}
	}

	// Processor API (special authorization)
	processor := router.Group("/api/p/v1")
	processor.Use(middlewares.HasProcessorAuthorization(cfg.ProcessorSecret, cfg.ProcessorUserID))
	{
		processor.POST("/posts", handlers.CreatePost(createPostServ))
	}

	// Swagger documentation
	router.GET("/api/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	return router
}
```

**Key Points:**
- Clear separation of public and protected routes
- Dependencies injected from outer layer
- Services initialized before routes
- Middleware applied at appropriate levels
- Swagger documentation endpoint

---

## Example 2: Environment Management API (Clean Architecture)

```go
package server

import (
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/mongo"

	"env0/config"
	"env0/internal/application"
	"env0/internal/infrastructure/handlers"
	"env0/internal/infrastructure/mail"
	"env0/internal/infrastructure/middlewares"
	"env0/internal/infrastructure/persistence"
)

func New(cfg config.Config, db *mongo.Database) *gin.Engine {
	router := gin.Default()
	router.Use(middlewares.UseCORS())

	// Configure URL path handling
	router.UseRawPath = true
	router.UnescapePathValues = false

	// Initialize infrastructure services
	mailSender := mail.NewMailSender(cfg.MailFromEmail, cfg.MailAppPassword)

	// Initialize repositories
	appRepo := persistence.NewAppRepo(db, cfg.AppEnvironmentKey)
	userRepo := persistence.NewUserRepo(db)
	appHistoryRepo := persistence.NewAppHistoryRepo(db, cfg.AppEnvironmentKey)

	// Initialize application scripts (use cases)
	addUserToApp := application.NewAddUserToAppScript(appRepo, userRepo, appHistoryRepo)
	createApp := application.NewCreateAppScript(appRepo, userRepo, appHistoryRepo)
	deleteApp := application.NewDeleteAppScript(appRepo, userRepo, appHistoryRepo)
	getApp := application.NewGetAppScript(appRepo, userRepo)
	listApps := application.NewListAppsScript(appRepo)
	login := application.NewLoginScript(userRepo, cfg.JWTSecret)
	register := application.NewRegisterScript(userRepo, mailSender)
	updateApp := application.NewUpdateAppScript(appRepo, userRepo, appHistoryRepo)
	updateUser := application.NewUpdateUserScript(userRepo)
	updateUserPassword := application.NewUpdateUserPasswordScript(userRepo)
	removeUserOfApp := application.NewRemoveUserOfAppScript(appRepo, userRepo, appHistoryRepo)
	listUsers := application.NewListUsersScript(appRepo, userRepo)

	// API routes
	backoffice := router.Group("/api/v1")
	{
		// Public routes
		backoffice.POST("/register", handlers.Register(register))
		backoffice.POST("/login", handlers.Login(login))

		// Protected routes
		backoffice.Use(middlewares.HasAuthorization(cfg.JWTSecret))
		{
			// App management
			backoffice.GET("/apps", handlers.ListApps(listApps))
			backoffice.GET("/apps/:fullAppName", handlers.GetApp(getApp))
			backoffice.POST("/apps", handlers.CreateApp(createApp))
			backoffice.PUT("/apps/:fullAppName", handlers.UpdateApp(updateApp))
			backoffice.DELETE("/apps/:fullAppName", handlers.DeleteApp(deleteApp))

			// App user management
			backoffice.PUT(
				"/apps/:fullAppName/users/:userName",
				handlers.AddUserToApp(addUserToApp),
			)
			backoffice.DELETE(
				"/apps/:fullAppName/users/:userName",
				handlers.RemoveUserOfApp(removeUserOfApp),
			)
			backoffice.GET(
				"/apps/:fullAppName/users",
				handlers.ListUsers(listUsers),
			)

			// User profile management
			backoffice.PATCH("/users/me", handlers.UpdateUser(updateUser))
			backoffice.PUT(
				"/users/me/password",
				handlers.UpdateUserPassword(updateUserPassword),
			)
		}
	}

	return router
}
```

---

## Simple Server Pattern (For Small APIs)

```go
package server

import (
	"database/sql"

	"github.com/gin-gonic/gin"

	"myapi/config"
	"myapi/internal/handlers"
	"myapi/internal/middleware"
	"myapi/internal/repository"
	"myapi/internal/service"
)

func New(cfg config.Config, db *sql.DB) *gin.Engine {
	router := gin.Default()

	// Global middleware
	router.Use(middleware.CORS())
	router.Use(middleware.RequestID())
	router.Use(middleware.Logger())

	// Health check
	router.GET("/health", handlers.Health(db))

	// Initialize layers
	userRepo := repository.NewUserRepository(db)
	userService := service.NewUserService(userRepo)
	userHandler := handlers.NewUserHandler(userService)

	// API routes
	api := router.Group("/api/v1")
	{
		// Public routes
		api.POST("/register", userHandler.Register)
		api.POST("/login", userHandler.Login)

		// Protected routes
		protected := api.Group("")
		protected.Use(middleware.Auth(cfg.JWTSecret))
		{
			protected.GET("/users/:id", userHandler.GetUser)
			protected.PUT("/users/:id", userHandler.UpdateUser)
			protected.DELETE("/users/:id", userHandler.DeleteUser)
		}
	}

	return router
}
```

---

## Best Practices

### 1. Dependency Injection
```go
// Good: Dependencies passed as parameters
func New(cfg config.Config, db *sql.DB) *gin.Engine {
	repo := repository.New(db)
	service := service.New(repo)
	handler := handlers.New(service)
	// ...
}

// Bad: Using global variables
var globalDB *sql.DB

func New(cfg config.Config) *gin.Engine {
	repo := repository.New(globalDB) // Avoid this!
	// ...
}
```

### 2. Middleware Order Matters
```go
router := gin.Default()

// 1. CORS (must be first)
router.Use(middleware.CORS())

// 2. Request tracking
router.Use(middleware.RequestID())

// 3. Logging
router.Use(middleware.Logger())

// 4. Recovery (catch panics)
router.Use(middleware.Recovery())

// Then define routes...
```

### 3. Route Grouping
```go
api := router.Group("/api/v1")
{
	// Public routes first
	api.POST("/login", handlers.Login)

	// Then protected routes
	api.Use(middleware.Auth(jwtSecret))
	{
		api.GET("/users", handlers.ListUsers)
		api.POST("/users", handlers.CreateUser)
	}
}
```

### 4. RESTful Route Naming
```go
// Resource-based routing
api.GET("/users", handlers.ListUsers)           // List all
api.POST("/users", handlers.CreateUser)         // Create
api.GET("/users/:id", handlers.GetUser)         // Get one
api.PUT("/users/:id", handlers.UpdateUser)      // Update
api.DELETE("/users/:id", handlers.DeleteUser)   // Delete

// Nested resources
api.GET("/users/:id/posts", handlers.ListUserPosts)
api.POST("/users/:id/posts", handlers.CreateUserPost)
```

### 5. Version Your API
```go
v1 := router.Group("/api/v1")
{
	v1.GET("/users", handlersV1.ListUsers)
}

v2 := router.Group("/api/v2")
{
	v2.GET("/users", handlersV2.ListUsers)
}
```
