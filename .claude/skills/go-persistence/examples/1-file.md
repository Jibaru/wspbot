# Example of file implementation

```go
package json

const filePath = "orders.json"

func StoreOrder(ctx context.Context, order Order) error {
  osFile, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
  if err != nil {
    return err
  }
  defer osFile.Close()

  orderJSON, err := json.Marshal(order)
  if err != nil {
    return err
  }

  _, err = osFile.Write(orderJSON)
  if err != nil {
    return err
  }

  return nil
}

func GetOrders(ctx context.Context) ([]Order, error) {
  osFile, err := os.Open(filePath)
  if err != nil {
    return nil, err
  }
  defer osFile.Close()

  var orders []Order
  decoder := json.NewDecoder(osFile)
  for {
    var order Order
    if err := decoder.Decode(&order); err == io.EOF {
      break
    } else if err != nil {
      return nil, err
    }
    orders = append(orders, order)
  }

  return orders, nil
}
```