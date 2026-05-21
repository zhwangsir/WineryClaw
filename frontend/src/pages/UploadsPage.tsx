import { useState } from "react";
import { Button, Card, Upload } from "antd";
import { UploadOutlined, FileOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useUploadsStore } from "../stores/uploadsStore";

export default function UploadsPage() {
  const { loading, upload } = useUploadsStore();
  const [fileList, setFileList] = useState<any[]>([]);

  const handleUpload = async (file: File) => {
    await upload(file);
    return false; // Prevent default upload
  };

  return (
    <PageShell
      title="上传"
      subtitle="文件上传与管理"
      icon={<FileOutlined />}
    >
      <Card
        style={{ borderRadius: 12, border: "1px solid var(--c-border)", maxWidth: 600 }}
        styles={{ body: { padding: 32 } }}
      >
        <Upload
          fileList={fileList}
          onChange={({ fileList: fl }) => setFileList(fl)}
          beforeUpload={handleUpload}
          multiple
        >
          <Button icon={<UploadOutlined />} loading={loading} size="large">
            选择文件上传
          </Button>
        </Upload>
        <div style={{ marginTop: 16, fontSize: 12, color: "var(--c-text-3)" }}>
          支持多文件上传，文件将存储在服务端 uploads 目录
        </div>
      </Card>
    </PageShell>
  );
}
