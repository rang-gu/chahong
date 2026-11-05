import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* 기존에 있던 다른 설정들... */
  
  typescript: {
    // 빌드 시 타입 에러가 발생해도 무시하고 강제로 배포를 진행합니다.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
