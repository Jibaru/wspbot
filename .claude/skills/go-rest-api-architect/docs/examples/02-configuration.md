# Configuration Examples

## Configuration Pattern

Configuration should:
- Load from environment variables
- Support .env files for development
- Validate required variables
- Provide sensible defaults where appropriate

---

## Example 1: Reflection-Based Config (blog0)

This approach uses reflection to automatically map environment variables to struct fields.

```go
package config

import (
	"errors"
	"log"
	"os"
	"reflect"

	"github.com/joho/godotenv"
)

type Config struct {
	APIBaseURI         string `env:"API_BASE_URI"`
	WebBaseURI         string `env:"WEB_BASE_URI"`
	PostgresURI        string `env:"POSTGRES_URI"`
	JWTSecret          string `env:"JWT_SECRET"`
	APIPort            string `env:"API_PORT"`
	DBName             string `env:"DB_NAME"`
	GoogleClientID     string `env:"GOOGLE_CLIENT_ID"`
	GoogleClientSecret string `env:"GOOGLE_CLIENT_SECRET"`
	OpenAIApiKey       string `env:"OPENAI_API_KEY"`
	TriggerSecretKey   string `env:"TRIGGER_SECRET_KEY"`
	ProcessorSecret    string `env:"PROCESSOR_SECRET"`
	ProcessorUserID    string `env:"PROCESSOR_USER_ID"`
}

func Load() Config {
	if err := godotenv.Load(); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Println(".env not found, using environment variables as default")
		} else {
			log.Fatal("error loading .env", err)
		}
	}

	var cfg Config
	loadFromEnv(&cfg)
	return cfg
}

func loadFromEnv(cfg *Config) {
	v := reflect.ValueOf(cfg).Elem()
	t := v.Type()

	for i := 0; i < v.NumField(); i++ {
		field := v.Field(i)
		fieldType := t.Field(i)

		if envTag := fieldType.Tag.Get("env"); envTag != "" {
			if envValue := os.Getenv(envTag); envValue != "" {
				field.SetString(envValue)
			}
		}
	}
}
```

**Advantages:**
- Automatic mapping using struct tags
- Easy to add new config fields
- DRY (Don't Repeat Yourself)

**Usage:**
```go
cfg := config.Load()
fmt.Println(cfg.APIPort)
```

---

## Example 2: Explicit Config (env0)

This approach explicitly reads each environment variable.

```go
package config

import (
	"errors"
	"log"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	MongoURI          string
	JWTSecret         string
	APIPort           string
	DBName            string
	MailAppPassword   string
	MailFromEmail     string
	AppEnvironmentKey string
}

func Load() Config {
	if err := godotenv.Load(); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Println(".env not found, using environment variables as default")
		} else {
			log.Fatal("error loading .env", err)
		}
	}

	mongoURI, ok := os.LookupEnv("MONGODB_URI")
	if !ok {
		log.Fatal("MONGODB_URI not configured")
	}

	jwtSecret, ok := os.LookupEnv("JWT_SECRET")
	if !ok {
		log.Fatal("JWT_SECRET not configured")
	}

	appPort, ok := os.LookupEnv("PORT")
	if !ok {
		appPort = "8080" // Default value
	}

	mailAppPassword, ok := os.LookupEnv("MAIL_APP_PASSWORD")
	if !ok {
		log.Fatal("MAIL_APP_PASSWORD not configured")
	}

	mailFromEmail, ok := os.LookupEnv("MAIL_FROM_EMAIL")
	if !ok {
		log.Fatal("MAIL_FROM_EMAIL not configured")
	}

	appEnvironmentKey, ok := os.LookupEnv("APP_ENVIRONMENT_KEY")
	if !ok {
		log.Fatal("APP_ENVIRONMENT_KEY not configured")
	}

	return Config{
		MongoURI:          mongoURI,
		JWTSecret:         jwtSecret,
		APIPort:           appPort,
		DBName:            "envzero",
		MailAppPassword:   mailAppPassword,
		MailFromEmail:     mailFromEmail,
		AppEnvironmentKey: appEnvironmentKey,
	}
}
```

**Advantages:**
- Explicit validation for required fields
- Clear default values
- Easy to understand flow
- Better error messages

---

## Example .env File

```env
# API Configuration
API_PORT=8080
API_BASE_URI=http://localhost:8080
WEB_BASE_URI=http://localhost:3000

# Database
POSTGRES_URI=postgresql://user:password@localhost:5432/dbname?sslmode=disable
# or for MongoDB
MONGODB_URI=mongodb://localhost:27017/dbname

# Security
JWT_SECRET=your-super-secret-jwt-key-change-in-production

# External Services
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
OPENAI_API_KEY=sk-your-openai-key

# Email
MAIL_FROM_EMAIL=noreply@example.com
MAIL_APP_PASSWORD=your-mail-password
```

---

## Best Practices

1. **Never commit .env files** - Add to .gitignore
2. **Validate critical config** - Fatal error on missing required variables
3. **Provide defaults for optional config** - Like API_PORT defaulting to 8080
4. **Use meaningful names** - Clear and descriptive variable names
5. **Document required variables** - In README or example.env
6. **Separate concerns** - Different configs for dev/staging/prod
