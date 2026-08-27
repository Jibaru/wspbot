# Domain Entity Examples

## Domain Entity Principles

Domain entities should:
- Encapsulate business rules and invariants
- Use private fields with exported methods
- Validate state on creation and modification
- Be database-agnostic
- Contain business logic, not infrastructure concerns

---

## Example 1: Post Entity with Validation (blog0)

```go
package domain

import (
	"encoding/json"
	"fmt"
	"time"
)

type Post struct {
	ID          string          `sql:"id,primary"`
	AuthorID    string          `sql:"author_id"`
	Title       string          `sql:"title"`
	Slug        string          `sql:"slug"`
	RawMarkdown string          `sql:"raw_markdown"`
	Summary     string          `sql:"summary"`
	Tags        json.RawMessage `sql:"tags"`
	PublishedAt *time.Time      `sql:"published_at"`
	CreatedAt   time.Time       `sql:"created_at"`
	UpdatedAt   time.Time       `sql:"updated_at"`

	RawMarkdownAudioURL *string `sql:"raw_markdown_audio_url"`
	SummaryAudioURL     *string `sql:"summary_audio_url"`
}

func NewPost(
	id string,
	authorID string,
	title string,
	slug string,
	rawMarkdown string,
	summary string,
	tags []string,
) (*Post, error) {
	// Validate required fields
	if id == "" {
		return nil, fmt.Errorf("id cannot be empty")
	}

	if authorID == "" {
		return nil, fmt.Errorf("author ID cannot be empty")
	}

	if title == "" {
		return nil, fmt.Errorf("title cannot be empty")
	}

	if slug == "" {
		return nil, fmt.Errorf("slug cannot be empty")
	}

	if rawMarkdown == "" {
		return nil, fmt.Errorf("raw markdown cannot be empty")
	}

	if summary == "" {
		return nil, fmt.Errorf("summary cannot be empty")
	}

	if len(tags) == 0 {
		return nil, fmt.Errorf("tags cannot be empty")
	}

	// Marshal tags to JSON
	rawTags, err := json.Marshal(tags)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal tags: %w", err)
	}

	now := time.Now()
	return &Post{
		ID:          id,
		AuthorID:    authorID,
		Title:       title,
		Slug:        slug,
		RawMarkdown: rawMarkdown,
		Summary:     summary,
		Tags:        rawTags,
		PublishedAt: nil,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func NewPublishedPost(
	id string,
	authorID string,
	title string,
	slug string,
	rawMarkdown string,
	summary string,
	tags []string,
	publishedAt time.Time,
) (*Post, error) {
	post, err := NewPost(id, authorID, title, slug, rawMarkdown, summary, tags)
	if err != nil {
		return nil, err
	}

	post.PublishedAt = &publishedAt
	return post, nil
}

// Publish marks a post as published
func (p *Post) Publish(publishedAt time.Time) {
	p.PublishedAt = &publishedAt
	p.UpdatedAt = time.Now()
}

// Update updates post content
func (p *Post) Update(title, slug, rawMarkdown, summary string, tags []string) error {
	if title == "" {
		return fmt.Errorf("title cannot be empty")
	}

	if slug == "" {
		return fmt.Errorf("slug cannot be empty")
	}

	if rawMarkdown == "" {
		return fmt.Errorf("raw markdown cannot be empty")
	}

	if summary == "" {
		return fmt.Errorf("summary cannot be empty")
	}

	if len(tags) == 0 {
		return fmt.Errorf("tags cannot be empty")
	}

	rawTags, err := json.Marshal(tags)
	if err != nil {
		return fmt.Errorf("failed to marshal tags: %w", err)
	}

	p.Title = title
	p.Slug = slug
	p.RawMarkdown = rawMarkdown
	p.Summary = summary
	p.Tags = rawTags
	p.UpdatedAt = time.Now()
	return nil
}

// TableName returns the database table name
func (p *Post) TableName() string {
	return "posts"
}

// ItsTags returns tags as string slice
func (p *Post) ItsTags() []string {
	var tags []string
	if len(p.Tags) == 0 {
		return tags
	}
	_ = json.Unmarshal(p.Tags, &tags)
	return tags
}

// Domain events
type PostCreated struct {
	PostID string
}

type PostUpdated struct {
	PostID string
}
```

---

## Example 2: App Entity with Encapsulation (env0)

```go
package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

var ErrApp = fmt.Errorf("error in app")

type App struct {
	id                   ID
	name                 string
	userID               ID
	envs                 map[string]map[string]any
	otherUsersAllowedIDs []ID
	createdAt            time.Time
}

func NewApp(
	id ID,
	name string,
	userID ID,
	envs map[string]map[string]any,
	otherUsersAllowedIDs []ID,
	createdAt time.Time,
) (*App, error) {
	app := &App{
		id:                   id,
		userID:               userID,
		envs:                 envs,
		otherUsersAllowedIDs: otherUsersAllowedIDs,
		createdAt:            createdAt,
	}

	if err := app.ChangeName(name); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrApp, err)
	}

	return app, nil
}

// Getters - Read-only access to private fields
func (a *App) ID() ID {
	return a.id
}

func (a *App) Name() string {
	return a.name
}

func (a *App) UserID() ID {
	return a.userID
}

func (a *App) Envs() map[string]map[string]any {
	return a.envs
}

func (a *App) OtherUsersAllowedIDs() []ID {
	return a.otherUsersAllowedIDs
}

func (a *App) CreatedAt() time.Time {
	return a.createdAt
}

// Business methods

// ChangeName updates the app name with validation
func (a *App) ChangeName(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("%w: name cannot be empty", ErrApp)
	}

	a.name = name
	return nil
}

// CanAllows checks if a user has access to this app
func (a *App) CanAllows(userID ID) bool {
	if a.userID == userID {
		return true
	}

	return slices.Contains(a.otherUsersAllowedIDs, userID)
}

// ChangeEnvs updates environment variables
func (a *App) ChangeEnvs(envs map[string]map[string]any) {
	a.envs = envs
}

// AddUserID grants access to another user
func (a *App) AddUserID(userID ID) {
	if slices.Contains(a.otherUsersAllowedIDs, userID) {
		return
	}

	a.otherUsersAllowedIDs = append(a.otherUsersAllowedIDs, userID)
}

// RemoveUserID revokes access from a user
func (a *App) RemoveUserID(userID ID) {
	ids := []ID{}
	for _, id := range a.otherUsersAllowedIDs {
		if id != userID {
			ids = append(ids, id)
		}
	}

	a.otherUsersAllowedIDs = ids
}

// Map converts entity to map for serialization
func (a App) Map() map[string]any {
	return map[string]any{
		"id":                   a.id,
		"name":                 a.name,
		"userId":               a.userID,
		"envs":                 a.envs,
		"otherUsersAllowedIds": a.otherUsersAllowedIDs,
		"createdAt":            a.createdAt,
	}
}

// MarshalJSON implements json.Marshaler
func (a App) MarshalJSON() ([]byte, error) {
	return json.Marshal(a.Map())
}
```

**Key Points:**
- Private fields with getter methods
- Business logic encapsulated in methods
- Validation in constructors and mutators
- Domain-specific methods (CanAllows, AddUserID)

---

## Example 3: User Entity with Value Objects

```go
package domain

import (
	"errors"
	"fmt"
	"regexp"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidEmail    = errors.New("invalid email format")
	ErrInvalidPassword = errors.New("invalid password")
)

// Email is a value object
type Email struct {
	value string
}

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)

func NewEmail(email string) (Email, error) {
	if !emailRegex.MatchString(email) {
		return Email{}, ErrInvalidEmail
	}
	return Email{value: email}, nil
}

func (e Email) String() string {
	return e.value
}

// User entity
type User struct {
	id           string
	email        Email
	passwordHash string
	name         string
	createdAt    time.Time
	updatedAt    time.Time
}

func NewUser(email, password, name string) (*User, error) {
	if name == "" {
		return nil, errors.New("name cannot be empty")
	}

	if len(password) < 8 {
		return nil, fmt.Errorf("%w: must be at least 8 characters", ErrInvalidPassword)
	}

	emailVO, err := NewEmail(email)
	if err != nil {
		return nil, err
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	now := time.Now()
	return &User{
		id:           generateID(),
		email:        emailVO,
		passwordHash: string(hashedPassword),
		name:         name,
		createdAt:    now,
		updatedAt:    now,
	}, nil
}

// Getters
func (u *User) ID() string {
	return u.id
}

func (u *User) Email() string {
	return u.email.String()
}

func (u *User) Name() string {
	return u.name
}

func (u *User) CreatedAt() time.Time {
	return u.createdAt
}

func (u *User) UpdatedAt() time.Time {
	return u.updatedAt
}

// Business methods

func (u *User) ValidatePassword(password string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(u.passwordHash), []byte(password))
	return err == nil
}

func (u *User) ChangeName(name string) error {
	if name == "" {
		return errors.New("name cannot be empty")
	}
	u.name = name
	u.updatedAt = time.Now()
	return nil
}

func (u *User) ChangeEmail(email string) error {
	emailVO, err := NewEmail(email)
	if err != nil {
		return err
	}
	u.email = emailVO
	u.updatedAt = time.Now()
	return nil
}

func (u *User) ChangePassword(newPassword string) error {
	if len(newPassword) < 8 {
		return fmt.Errorf("%w: must be at least 8 characters", ErrInvalidPassword)
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	u.passwordHash = string(hashedPassword)
	u.updatedAt = time.Now()
	return nil
}
```

---

## Example 4: Order Aggregate

```go
package domain

import (
	"errors"
	"time"
)

type OrderStatus string

const (
	OrderStatusPending   OrderStatus = "pending"
	OrderStatusConfirmed OrderStatus = "confirmed"
	OrderStatusShipped   OrderStatus = "shipped"
	OrderStatusDelivered OrderStatus = "delivered"
	OrderStatusCancelled OrderStatus = "cancelled"
)

type OrderItem struct {
	productID string
	quantity  int
	price     float64
}

func NewOrderItem(productID string, quantity int, price float64) *OrderItem {
	return &OrderItem{
		productID: productID,
		quantity:  quantity,
		price:     price,
	}
}

func (oi *OrderItem) Total() float64 {
	return float64(oi.quantity) * oi.price
}

type Order struct {
	id        string
	userID    string
	items     []*OrderItem
	status    OrderStatus
	createdAt time.Time
	updatedAt time.Time
}

func NewOrder(userID string, items []*OrderItem) *Order {
	if len(items) == 0 {
		panic("order must have at least one item")
	}

	now := time.Now()
	return &Order{
		id:        generateID(),
		userID:    userID,
		items:     items,
		status:    OrderStatusPending,
		createdAt: now,
		updatedAt: now,
	}
}

func (o *Order) ID() string {
	return o.id
}

func (o *Order) UserID() string {
	return o.userID
}

func (o *Order) Items() []*OrderItem {
	return o.items
}

func (o *Order) Status() OrderStatus {
	return o.status
}

func (o *Order) Total() float64 {
	total := 0.0
	for _, item := range o.items {
		total += item.Total()
	}
	return total
}

// Business rules

func (o *Order) Confirm() error {
	if o.status != OrderStatusPending {
		return errors.New("only pending orders can be confirmed")
	}
	o.status = OrderStatusConfirmed
	o.updatedAt = time.Now()
	return nil
}

func (o *Order) Ship() error {
	if o.status != OrderStatusConfirmed {
		return errors.New("only confirmed orders can be shipped")
	}
	o.status = OrderStatusShipped
	o.updatedAt = time.Now()
	return nil
}

func (o *Order) Deliver() error {
	if o.status != OrderStatusShipped {
		return errors.New("only shipped orders can be delivered")
	}
	o.status = OrderStatusDelivered
	o.updatedAt = time.Now()
	return nil
}

func (o *Order) Cancel() error {
	if o.status == OrderStatusDelivered {
		return errors.New("delivered orders cannot be cancelled")
	}
	if o.status == OrderStatusCancelled {
		return errors.New("order is already cancelled")
	}
	o.status = OrderStatusCancelled
	o.updatedAt = time.Now()
	return nil
}
```

---

## Best Practices

### 1. Use Constructor Functions

```go
// Good: Constructor with validation
func NewUser(email, password, name string) (*User, error) {
	if email == "" {
		return nil, errors.New("email is required")
	}
	// ... validation
	return &User{email: email, name: name}, nil
}

// Bad: Direct struct initialization
user := &User{Email: email, Name: name} // No validation!
```

### 2. Encapsulate Fields

```go
// Good: Private fields with getters
type User struct {
	id    string
	email string
}

func (u *User) ID() string {
	return u.id
}

// Bad: Public fields
type User struct {
	ID    string
	Email string
}
```

### 3. Validate on Mutation

```go
func (u *User) ChangeName(name string) error {
	if name == "" {
		return errors.New("name cannot be empty")
	}
	u.name = name
	u.updatedAt = time.Now()
	return nil
}
```

### 4. Use Value Objects for Domain Concepts

```go
type Money struct {
	amount   float64
	currency string
}

func NewMoney(amount float64, currency string) (Money, error) {
	if amount < 0 {
		return Money{}, errors.New("amount cannot be negative")
	}
	return Money{amount: amount, currency: currency}, nil
}
```

### 5. Keep Entities Database-Agnostic

```go
// Good: No database tags in domain
type User struct {
	id    string
	email string
}

// Bad: Database concerns in domain
type User struct {
	ID    string `db:"id" json:"id"`
	Email string `db:"email" json:"email"`
}

// Use separate persistence models if needed
```
