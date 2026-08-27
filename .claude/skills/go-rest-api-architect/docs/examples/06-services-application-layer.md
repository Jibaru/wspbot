# Service / Application Layer Examples

## Service Layer Responsibilities

The service layer (or application layer in Clean Architecture) should:
- Implement business logic and use cases
- Orchestrate multiple repositories
- Validate business rules
- Handle transactions
- Transform domain entities to/from DTOs
- Be independent of HTTP concerns

---

## Example 1: Create Post Service (blog0)

```go
package services

import (
	"context"
	"fmt"
	"time"

	"blog0/internal/domain"
	"blog0/internal/domain/dao"
)

type CreatePost struct {
	postDAO              dao.PostDAO
	nextID               domain.NextID
	postContentGenerator domain.PostContentGenerator
	eventBus             domain.EventBus
}

type CreatePostReq struct {
	Title       string `json:"title"`
	Slug        string `json:"slug"`
	RawMarkdown string `json:"raw_markdown"`
	UserID      string `json:"-"`
	Publish     bool   `json:"publish"`
}

type CreatePostResp struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Slug        string     `json:"slug"`
	RawMarkdown string     `json:"raw_markdown"`
	Summary     string     `json:"summary"`
	AuthorID    string     `json:"author_id"`
	Tags        []string   `json:"tags"`
	PublishedAt *time.Time `json:"published_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func NewCreatePost(
	postDAO dao.PostDAO,
	nextID domain.NextID,
	postContentGenerator domain.PostContentGenerator,
	eventBus domain.EventBus,
) *CreatePost {
	return &CreatePost{
		postDAO:              postDAO,
		nextID:               nextID,
		postContentGenerator: postContentGenerator,
		eventBus:             eventBus,
	}
}

func (s *CreatePost) Exec(ctx context.Context, req *CreatePostReq) (*CreatePostResp, error) {
	// Generate unique ID
	postID := s.nextID()

	// Generate AI-powered content
	summary, err := s.postContentGenerator.GenerateSummary(ctx, req.RawMarkdown)
	if err != nil {
		return nil, err
	}

	tags, err := s.postContentGenerator.GenerateTags(ctx, req.RawMarkdown)
	if err != nil {
		return nil, err
	}

	// Create domain entity
	var post *domain.Post
	if req.Publish {
		publishedAt := time.Now()
		post, err = domain.NewPublishedPost(
			postID,
			req.UserID,
			req.Title,
			req.Slug,
			req.RawMarkdown,
			summary,
			tags,
			publishedAt,
		)
	} else {
		post, err = domain.NewPost(
			postID,
			req.UserID,
			req.Title,
			req.Slug,
			req.RawMarkdown,
			summary,
			tags,
		)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to create post: %w", err)
	}

	// Persist to database
	err = s.postDAO.Create(ctx, post)
	if err != nil {
		return nil, fmt.Errorf("failed to save post: %w", err)
	}

	// Publish domain events
	err = s.eventBus.ProcessEvents([]any{
		&domain.PostCreated{
			PostID: post.ID,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to process events: %w", err)
	}

	// Map to response DTO
	return &CreatePostResp{
		ID:          post.ID,
		Title:       post.Title,
		Slug:        post.Slug,
		RawMarkdown: post.RawMarkdown,
		Summary:     post.Summary,
		AuthorID:    post.AuthorID,
		Tags:        post.ItsTags(),
		PublishedAt: post.PublishedAt,
		CreatedAt:   post.CreatedAt,
		UpdatedAt:   post.UpdatedAt,
	}, nil
}
```

**Key Points:**
- Constructor function for dependency injection
- Separate request/response types
- Context passed for cancellation
- Domain entity creation with validation
- Event publishing for side effects
- Proper error wrapping

---

## Example 2: Create App Application Script (env0)

```go
package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/mongo"

	"env0/internal/domain"
)

var ErrCreateApp = errors.New("failed to create app")

type CreateAppReq struct {
	Name   string
	UserID string
}

type CreateAppResp struct {
	ID        string
	Name      string
	UserID    string
	Envs      map[string]map[string]any
	CreatedAt time.Time
	OwnerName string
}

type CreateAppScript struct {
	appRepo        domain.AppRepo
	userRepo       domain.UserRepo
	appHistoryRepo domain.AppHistoryRepo
}

func NewCreateAppScript(
	appRepo domain.AppRepo,
	userRepo domain.UserRepo,
	appHistoryRepo domain.AppHistoryRepo,
) *CreateAppScript {
	return &CreateAppScript{
		appRepo:        appRepo,
		userRepo:       userRepo,
		appHistoryRepo: appHistoryRepo,
	}
}

func (s *CreateAppScript) Exec(ctx context.Context, req CreateAppReq) (*CreateAppResp, error) {
	// Validate and convert user ID
	userID, err := domain.NewID(req.UserID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid user ID: %v", ErrCreateApp, err)
	}

	// Get owner information
	owner, err := s.userRepo.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to get owner: %v", ErrCreateApp, err)
	}

	// Business rule: Check for duplicate app names per user
	existing, err := s.appRepo.ListApps(ctx, domain.Criteria{
		Filters: []domain.Filter{
			{
				Field: "name",
				Type:  domain.Equals,
				Value: req.Name,
			},
			{
				Field: "userId",
				Type:  domain.Equals,
				Value: owner.ID(),
			},
		},
	})
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fmt.Errorf("%w: failed to check existing apps: %v", ErrCreateApp, err)
	}

	if len(existing) > 0 {
		return nil, fmt.Errorf(
			"%w: app with name %s already exists for user %s",
			ErrCreateApp,
			req.Name,
			owner.Username(),
		)
	}

	// Create domain entity
	app, err := domain.NewApp(
		domain.NewAutoID(),
		req.Name,
		owner.ID(),
		make(map[string]map[string]any),
		make([]domain.ID, 0),
		Now().UTC(),
	)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create app domain model: %v", ErrCreateApp, err)
	}

	// Persist app
	err = s.appRepo.SaveApp(ctx, *app)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to save app: %v", ErrCreateApp, err)
	}

	// Create audit history
	history := domain.NewAppHistory(
		domain.NewAutoID(),
		owner.ID(),
		app,
		Now().UTC(),
		domain.AppHistoryCreated,
		fmt.Sprintf("App %s was created by %s", app.Name(), owner.Username()),
	)

	if err := s.appHistoryRepo.SaveAppHistory(ctx, *history); err != nil {
		return nil, fmt.Errorf("%w: failed to save app history: %v", ErrCreateApp, err)
	}

	// Return response DTO
	return &CreateAppResp{
		ID:        app.ID().Hex(),
		Name:      app.Name(),
		UserID:    app.UserID().Hex(),
		Envs:      app.Envs(),
		CreatedAt: app.CreatedAt(),
		OwnerName: owner.Username(),
	}, nil
}
```

**Key Points:**
- Multiple repository coordination
- Business rule validation (duplicate check)
- Audit trail creation
- Domain-driven error handling
- Rich response with related data

---

## Example 3: Simple CRUD Service

```go
package service

import (
	"context"
	"errors"
	"fmt"

	"myapi/internal/domain"
	"myapi/internal/repository"
)

var (
	ErrUserNotFound = errors.New("user not found")
	ErrUserExists   = errors.New("user already exists")
	ErrInvalidInput = errors.New("invalid input")
)

type UserService struct {
	userRepo repository.UserRepository
}

func NewUserService(userRepo repository.UserRepository) *UserService {
	return &UserService{
		userRepo: userRepo,
	}
}

// Create creates a new user
func (s *UserService) Create(ctx context.Context, email, password, name string) (*domain.User, error) {
	// Business validation
	if email == "" || password == "" || name == "" {
		return nil, ErrInvalidInput
	}

	// Check if user already exists
	existing, err := s.userRepo.FindByEmail(ctx, email)
	if err == nil && existing != nil {
		return nil, ErrUserExists
	}

	// Create domain entity
	user, err := domain.NewUser(email, password, name)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	// Persist
	if err := s.userRepo.Save(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to save user: %w", err)
	}

	return user, nil
}

// GetByID retrieves a user by ID
func (s *UserService) GetByID(ctx context.Context, id string) (*domain.User, error) {
	user, err := s.userRepo.FindByID(ctx, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	return user, nil
}

// List returns paginated users
func (s *UserService) List(ctx context.Context, page, pageSize int) ([]*domain.User, int64, error) {
	offset := (page - 1) * pageSize
	users, err := s.userRepo.FindAll(ctx, offset, pageSize)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list users: %w", err)
	}

	count, err := s.userRepo.Count(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count users: %w", err)
	}

	return users, count, nil
}

// UpdateUserParams holds optional update fields
type UpdateUserParams struct {
	Name  *string
	Email *string
}

// Update updates user information
func (s *UserService) Update(ctx context.Context, id string, params UpdateUserParams) (*domain.User, error) {
	user, err := s.userRepo.FindByID(ctx, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to get user: %w", err)
	}

	// Update only provided fields
	if params.Name != nil {
		user.ChangeName(*params.Name)
	}
	if params.Email != nil {
		// Business rule: Check email uniqueness
		existing, _ := s.userRepo.FindByEmail(ctx, *params.Email)
		if existing != nil && existing.ID != user.ID {
			return nil, ErrUserExists
		}
		user.ChangeEmail(*params.Email)
	}

	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to update user: %w", err)
	}

	return user, nil
}

// Delete deletes a user
func (s *UserService) Delete(ctx context.Context, id string) error {
	user, err := s.userRepo.FindByID(ctx, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return ErrUserNotFound
		}
		return fmt.Errorf("failed to get user: %w", err)
	}

	if err := s.userRepo.Delete(ctx, user.ID); err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}

	return nil
}
```

---

## Example 4: Service with Transaction

```go
package service

import (
	"context"
	"fmt"

	"myapi/internal/domain"
	"myapi/internal/repository"
)

type OrderService struct {
	orderRepo   repository.OrderRepository
	productRepo repository.ProductRepository
	db          repository.DB
}

func NewOrderService(
	orderRepo repository.OrderRepository,
	productRepo repository.ProductRepository,
	db repository.DB,
) *OrderService {
	return &OrderService{
		orderRepo:   orderRepo,
		productRepo: productRepo,
		db:          db,
	}
}

func (s *OrderService) CreateOrder(ctx context.Context, userID string, items []OrderItem) (*domain.Order, error) {
	// Start transaction
	tx, err := s.db.BeginTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Validate and reserve inventory
	var orderItems []*domain.OrderItem
	for _, item := range items {
		product, err := s.productRepo.FindByIDForUpdate(ctx, tx, item.ProductID)
		if err != nil {
			return nil, fmt.Errorf("product not found: %w", err)
		}

		// Business rule: Check inventory
		if product.Stock < item.Quantity {
			return nil, fmt.Errorf("insufficient stock for product %s", product.ID)
		}

		// Reduce stock
		product.ReduceStock(item.Quantity)
		if err := s.productRepo.Update(ctx, tx, product); err != nil {
			return nil, fmt.Errorf("failed to update product: %w", err)
		}

		orderItem := domain.NewOrderItem(product.ID, item.Quantity, product.Price)
		orderItems = append(orderItems, orderItem)
	}

	// Create order
	order := domain.NewOrder(userID, orderItems)
	if err := s.orderRepo.Save(ctx, tx, order); err != nil {
		return nil, fmt.Errorf("failed to save order: %w", err)
	}

	// Commit transaction
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return order, nil
}
```

---

## Best Practices

### 1. Dependency Injection via Constructor

```go
// Good: Dependencies injected
type UserService struct {
	userRepo repository.UserRepository
	mailer   mail.Sender
}

func NewUserService(userRepo repository.UserRepository, mailer mail.Sender) *UserService {
	return &UserService{
		userRepo: userRepo,
		mailer:   mailer,
	}
}

// Bad: Using global variables
var globalRepo repository.UserRepository

func (s *UserService) Create(ctx context.Context, user *domain.User) error {
	return globalRepo.Save(ctx, user) // Avoid this!
}
```

### 2. Return Domain Errors

```go
var (
	ErrUserNotFound     = errors.New("user not found")
	ErrUserExists       = errors.New("user already exists")
	ErrInvalidPassword  = errors.New("invalid password")
	ErrUnauthorized     = errors.New("unauthorized")
)

func (s *UserService) Login(ctx context.Context, email, password string) (*domain.User, error) {
	user, err := s.userRepo.FindByEmail(ctx, email)
	if err != nil {
		return nil, ErrUserNotFound
	}

	if !user.ValidatePassword(password) {
		return nil, ErrInvalidPassword
	}

	return user, nil
}
```

### 3. Use Context for Cancellation

```go
func (s *UserService) Create(ctx context.Context, req CreateUserReq) (*domain.User, error) {
	// Check if context is cancelled
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	// Continue with business logic...
	user, err := domain.NewUser(req.Email, req.Password, req.Name)
	// ...
}
```

### 4. Separate Request/Response Types

```go
// Input types
type CreateUserReq struct {
	Email    string
	Password string
	Name     string
}

type UpdateUserReq struct {
	Name  *string
	Email *string
}

// Output types
type UserResp struct {
	ID        string
	Email     string
	Name      string
	CreatedAt time.Time
}
```

### 5. Keep Services Focused

```go
// Good: Single responsibility
type UserService struct {
	userRepo repository.UserRepository
}

type OrderService struct {
	orderRepo repository.OrderRepository
}

// Bad: God service
type AppService struct {
	userRepo    repository.UserRepository
	orderRepo   repository.OrderRepository
	productRepo repository.ProductRepository
	// ... too many responsibilities
}
```
