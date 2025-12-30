# 📋 Ma Sói Web - Project Plan & Status Report
**Thời gian cập nhật:** 30/12/2025

Tài liệu này tổng hợp tiến độ hiện tại và định hướng phát triển tập trung hoàn toàn vào nền tảng **Web**.

---

## 🚀 1. Tiến Độ Hiện Tại (Current Status)

### 🟢 Đã Hoàn Thành (Completed Features)

#### **Core Game Loop**
*   [x] **Tạo/Tham gia phòng:** Host tạo phòng, người chơi tham gia bằng mã phòng.
*   [x] **Phân vai & Phases:** Tự động chia phe, chuyển đổi Ngày/Đêm/Vote mượt mà.
*   [x] **Điều kiện thắng:** Logic kiểm tra thắng thua tự động.

#### **Advanced Roles (Chức năng Vai trò)**
*   [x] **Sói (Wolf) & Sói Đầu Đàn (Alpha):** Vote giết chung, nguyền rủa.
*   [x] **Tiên Tri (Seer):** Soi danh tính.
*   [x] **Phù Thủy (Witch):** Dùng thuốc Giết & Cứu (Có UI chọn người cứu).
*   [x] **Thợ Săn (Hunter):** Ghim mục tiêu, kéo theo người chết khi bị giết.
*   [x] **Bảo Vệ (Bodyguard):** Bảo vệ người chơi (Logic chặn trùng lặp).
*   [x] **Thám Tử (Detective):** Soi hoạt động đêm.

#### **Host Management**
*   [x] **Kick Player:** Nút Kick hoạt động cho tất cả người chơi.
*   [x] **Visibility:** Host thấy toàn bộ Role.
*   [x] **Real-time Logs:** Log hành động chi tiết.

---

## 📝 2. Kế Hoạch Tiếp Theo (Web-Only Focus)

### 🔴 Ưu Tiên Cao (Urgent High Priority)

1.  **Tối Ưu Trải Nghiệm Web Mobile (Mobile Web UX):**
    *   [ ] **Responsive Design:** Tinh chỉnh CSS để giao diện đẹp, không vỡ trên mọi kích thước màn hình điện thoại (dọc/ngang).
    *   [ ] **Full-screen Mode:** Thêm nút để web chạy toàn màn hình (giống App).
    *   [ ] **Touch Interactions:** Tối ưu vùng bấm nút cho ngón tay.

2.  **Cải Thiện Giao Diện & Hiệu Ứng (Visual Polish):**
    *   [ ] **Visual Feedback:** Animation khi chuyển Ngày/Đêm (Màn hình tối dần, icon mặt trăng/mặt trời).
    *   [ ] **Role Icons:** Thêm icon hình ảnh đẹp cho từng Role thay vì text đơn giản.
    *   [ ] **Vote Result Animation:** Hiệu ứng hiển thị kết quả bầu cử kịch tính hơn.

### 🟡 Các Tính Năng Bổ Sung (Feature Expansion)

1.  **Hệ Thống Phòng Chờ & Cài Đặt:**
    *   [ ] **Reconnect:** Xử lý tốt hơn khi người chơi lỡ reload trang (giữ role, trạng thái).
    *   [ ] **Game Settings:** Host chỉnh thời gian vote, bật/tắt role cụ thể.

2.  **Role Mở Rộng (Nếu cần):**
    *   [ ] **Thần Tình Yêu (Cupid):** Ghép đôi 2 người chơi.
    *   [ ] **Kẻ Phản Bội (Traitor):** Hoàn thiện logic thắng riêng biệt.

---

## 🛠️ 3. Source Code & Deployment

*   **Repository:** `https://github.com/SlaMakeGameNoCode/ma-soi-server`
*   **Nền tảng:** Web Platform Pure (Node.js + Socket.io + Vanilla Click Client).
