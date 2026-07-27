/**
 * The route map of the whole app:
 *
 *   /login, /register  → public pages
 *   everything else    → behind ProtectedRoute, inside the Layout shell:
 *     /          → Dashboard
 *     /products  → Products
 *     /stock     → Stock
 */
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProductsPage } from "./pages/ProductsPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
import { StockPage } from "./pages/StockPage";
import { SuppliersPage } from "./pages/SuppliersPage";
import { SupplierDetailPage } from "./pages/SupplierDetailPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { PurchaseOrderDetailPage } from "./pages/PurchaseOrderDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AuditPage } from "./pages/AuditPage";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/products/:id" element={<ProductDetailPage />} />
            <Route path="/stock" element={<StockPage />} />
            <Route path="/suppliers" element={<SuppliersPage />} />
            <Route path="/suppliers/:id" element={<SupplierDetailPage />} />
            <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
            <Route
              path="/purchase-orders/new"
              element={<PurchaseOrderDetailPage />}
            />
            <Route
              path="/purchase-orders/:id"
              element={<PurchaseOrderDetailPage />}
            />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
