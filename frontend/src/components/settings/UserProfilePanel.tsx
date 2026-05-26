import { useState, useEffect, useCallback } from "react";
import { Card, Button, Spin, Empty, Tag, message } from "antd";
import {
  UserOutlined,
  ReloadOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { userProfileApi, type UserProfile } from "../../api/userProfile";

export default function UserProfilePanel() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await userProfileApi.getProfile();
      setProfile(resp.profile);
    } catch (e: any) {
      message.error(e.message || "获取用户画像失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const resp = await userProfileApi.refreshProfile();
      setProfile(resp.profile);
      message.success(resp.message || "用户画像已更新");
    } catch (e: any) {
      message.error(e.message || "更新失败");
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await userProfileApi.deleteProfile();
      setProfile(null);
      message.success("用户画像已清除");
    } catch (e: any) {
      message.error(e.message || "清除失败");
    } finally {
      setDeleting(false);
    }
  };

  const renderTags = (items: string[] | undefined) => {
    if (!items || items.length === 0) return <span style={{ color: "var(--c-text-secondary)" }}>暂无</span>;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.map((item) => (
          <Tag key={item} color="blue">
            {item}
          </Tag>
        ))}
      </div>
    );
  };

  return (
    <Card
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <UserOutlined />
          用户画像
        </span>
      }
      style={{ marginTop: 24, borderRadius: 12, border: "1px solid var(--c-border)", boxShadow: "var(--shadow)" }}
      extra={
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={handleRefresh}
          >
            立即更新
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={deleting}
            onClick={handleDelete}
            disabled={profile === null}
          >
            重置画像
          </Button>
        </div>
      }
    >
      {loading ? (
        <Spin />
      ) : profile === null ? (
        <Empty description="暂无画像，系统将在足够对话后自动生成" />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>名字</div>
            <div>{profile.name || "未识别"}</div>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>兴趣领域</div>
            {renderTags(profile.interests)}
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>沟通风格</div>
            <div>{profile.communication_style || "未识别"}</div>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>专业领域</div>
            {renderTags(profile.expertise_areas)}
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>常用工具</div>
            {renderTags(profile.preferred_tools)}
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>时区</div>
            <div>{profile.timezone || "未识别"}</div>
          </div>
        </div>
      )}
    </Card>
  );
}
